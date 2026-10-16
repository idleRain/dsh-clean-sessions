/**
 * 清理计划的构建:把归档 id 名单按磁盘状态、活跃度与路径安全性归类,再按血缘展开子代理后代。
 * 级联只作用于 origin 为 subagent 的子会话,基于会话 fork 出来的独立会话不参与。
 * @module dsh-clean-sessions/plan
 */

import {
  dirSizeBytes,
  findSessionDir,
  isPathInside,
  isRecentlyActive,
  realpathOrNull,
} from './fsutils.ts'
import { sessionsRoot } from './paths.ts'
import {
  buildSubagentChildIndex,
  collectSubagentAncestors,
  collectSubagentDescendants,
  invertChildIndex,
} from './lineage.ts'
import type { BlockedReason, CleanPlan, SessionLocation, SessionPlan } from './types.ts'

/** 归档会话的归类结果,不含血缘信息。 */
type PlanGroups = Pick<CleanPlan, 'toDelete' | 'recentExcluded' | 'ghosts' | 'unsafe'>

/** 归档名单内会话的既有归类,用于避免对名单内的后代重复判定。 */
type ArchiveVerdict = 'delete' | 'recent' | 'unsafe' | 'ghost'

/** 单个后代的判定结论。 */
type DescendantVerdict =
  | { kind: 'skip' }
  | { kind: 'deletable'; item: SessionPlan }
  | { kind: 'blocked'; reason: BlockedReason }

/** 会话目录的定位结果,unsafe 表示解析结果逃逸出 sessions 根目录。 */
type LocatedSession =
  | { kind: 'absent' }
  | { kind: 'unsafe'; location: SessionLocation }
  | { kind: 'found'; location: SessionLocation }

/** 级联判定共享的上下文。 */
interface CascadeContext {
  root: string
  rootReal: string | null
  minAgeMinutes: number
  includeRecent: boolean
  archivedVerdict: ReadonlyMap<string, ArchiveVerdict>
  index: ReadonlyMap<string, readonly string[]>
  parentsByChild: ReadonlyMap<string, readonly string[]>
}

/** 把归档 id 名单展开成清理计划,按磁盘状态与活跃度归类,默认继续展开子代理后代。 */
export function buildPlan(
  dshHome: string,
  archivedIds: readonly string[],
  minAgeMinutes: number,
  includeRecent: boolean,
  keepChildren = false,
): CleanPlan {
  const groups = classifyArchived(dshHome, archivedIds, minAgeMinutes, includeRecent)
  if (keepChildren || groups.toDelete.length === 0) {
    return { ...groups, cascade: [], blocked: [], lineageWarnings: [] }
  }
  return { ...groups, ...collectCascade(dshHome, groups, minAgeMinutes, includeRecent) }
}

/** 逐项定位归档会话并归类,此阶段不涉及血缘。 */
function classifyArchived(
  dshHome: string,
  archivedIds: readonly string[],
  minAgeMinutes: number,
  includeRecent: boolean,
): PlanGroups {
  const root = sessionsRoot(dshHome)
  const rootReal = realpathOrNull(root)
  const groups: PlanGroups = { toDelete: [], recentExcluded: [], ghosts: [], unsafe: [] }
  for (const id of archivedIds) {
    const located = locateSession(root, rootReal, id)
    if (located.kind === 'absent') {
      groups.ghosts.push({ id, sizeBytes: 0, recent: false, state: 'ghost' })
      continue
    }
    const recent = located.kind === 'found' && isRecentlyActive(located.location.dir, minAgeMinutes)
    const item: SessionPlan = {
      id,
      location: located.location,
      sizeBytes: dirSizeBytes(located.location.dir),
      recent,
      state: 'exists',
    }
    if (located.kind === 'unsafe') groups.unsafe.push(item)
    else if (recent && !includeRecent) groups.recentExcluded.push(item)
    else groups.toDelete.push(item)
  }
  return groups
}

/**
 * 定位会话目录并执行符号链接逃逸防护,目录名经 encodeSegment 编码后匹配。
 * 目录不可核实时的前置条件错误由 findSessionDir 抛出,不在此处降级。
 */
function locateSession(root: string, rootReal: string | null, id: string): LocatedSession {
  const location = findSessionDir(root, id)
  if (location === undefined) return { kind: 'absent' }
  const dirReal = rootReal === null ? null : realpathOrNull(location.dir)
  if (rootReal !== null && (dirReal === null || !isPathInside(dirReal, rootReal))) {
    return { kind: 'unsafe', location }
  }
  return { kind: 'found', location }
}

/** 展开待删会话的子代理后代,产出级联项、被后代阻止的祖先与血缘诊断。 */
function collectCascade(
  dshHome: string,
  groups: PlanGroups,
  minAgeMinutes: number,
  includeRecent: boolean,
): Pick<CleanPlan, 'toDelete' | 'cascade' | 'blocked' | 'lineageWarnings'> {
  const root = sessionsRoot(dshHome)
  const { index, diagnostics } = buildSubagentChildIndex(root)
  const deleteIds = new Set(groups.toDelete.map(item => item.id))
  const descendantIds = [...collectSubagentDescendants(deleteIds, index)].sort()
  if (descendantIds.length === 0) {
    return { toDelete: groups.toDelete, cascade: [], blocked: [], lineageWarnings: diagnostics }
  }
  const context: CascadeContext = {
    root,
    rootReal: realpathOrNull(root),
    minAgeMinutes,
    includeRecent,
    archivedVerdict: buildArchivedVerdict(groups),
    index,
    parentsByChild: invertChildIndex(index),
  }
  return resolveCascade(groups, context, descendantIds, diagnostics)
}

/** 汇总归档名单内每个会话的既有归类,供级联阶段复用而无需重新定位。 */
function buildArchivedVerdict(groups: PlanGroups): Map<string, ArchiveVerdict> {
  const verdicts = new Map<string, ArchiveVerdict>()
  for (const item of groups.ghosts) verdicts.set(item.id, 'ghost')
  for (const item of groups.recentExcluded) verdicts.set(item.id, 'recent')
  for (const item of groups.unsafe) verdicts.set(item.id, 'unsafe')
  for (const item of groups.toDelete) verdicts.set(item.id, 'delete')
  return verdicts
}

/** 判定全部后代并解析阻止关系,被阻止祖先连同其整个子树一并退出删除集合。 */
function resolveCascade(
  groups: PlanGroups,
  context: CascadeContext,
  descendantIds: readonly string[],
  diagnostics: readonly string[],
): Pick<CleanPlan, 'toDelete' | 'cascade' | 'blocked' | 'lineageWarnings'> {
  const deletable: SessionPlan[] = []
  const blockedDescendants = new Map<string, BlockedReason>()
  for (const id of descendantIds) {
    const verdict = classifyDescendant(context, id)
    if (verdict.kind === 'deletable') deletable.push(verdict.item)
    else if (verdict.kind === 'blocked') blockedDescendants.set(id, verdict.reason)
  }
  const scope = new Set([...groups.toDelete.map(item => item.id), ...descendantIds])
  const ancestors = collectSubagentAncestors(blockedDescendants.keys(), context.parentsByChild, scope)
  // 被阻止的祖先本身可能也是后代,它与它名下的整棵子树都必须退出删除集合
  const stayingRoots = new Set([...ancestors, ...blockedDescendants.keys()])
  const staying = new Set([...stayingRoots, ...collectSubagentDescendants(stayingRoots, context.index)])
  const { toDelete, blocked } = splitBlockedAncestors(groups, ancestors, blockedDescendants, context, scope)
  return { toDelete, cascade: deletable.filter(item => !staying.has(item.id)), blocked, lineageWarnings: [...diagnostics] }
}

/** 从待删集合中分离出被后代阻止的祖先,并附上可展示的原因。 */
function splitBlockedAncestors(
  groups: PlanGroups,
  ancestors: ReadonlySet<string>,
  blockedDescendants: ReadonlyMap<string, BlockedReason>,
  context: CascadeContext,
  scope: ReadonlySet<string>,
): Pick<CleanPlan, 'toDelete' | 'blocked'> {
  const toDelete: SessionPlan[] = []
  const blocked: SessionPlan[] = []
  for (const item of groups.toDelete) {
    if (!ancestors.has(item.id)) {
      toDelete.push(item)
      continue
    }
    blocked.push({ ...item, blockedReason: findBlockingReason(item.id, blockedDescendants, context, scope) })
  }
  return { toDelete, blocked }
}

/** 找出把该祖先拖入 blocked 的首个后代结论,使提示能指向具体后代与原因。 */
function findBlockingReason(
  ancestorId: string,
  blockedDescendants: ReadonlyMap<string, BlockedReason>,
  context: CascadeContext,
  scope: ReadonlySet<string>,
): BlockedReason | undefined {
  for (const [descendantId, reason] of blockedDescendants) {
    const chain = collectSubagentAncestors([descendantId], context.parentsByChild, scope)
    if (chain.has(ancestorId)) return reason
  }
  return undefined
}

/** 判定单个后代的处置:名单内的沿用既有结论,其余按逃逸防护与活跃度判定。 */
function classifyDescendant(context: CascadeContext, id: string): DescendantVerdict {
  const verdict = context.archivedVerdict.get(id)
  if (verdict !== undefined) return reuseArchivedVerdict(verdict, id)
  const located = locateSession(context.root, context.rootReal, id)
  if (located.kind === 'absent') return { kind: 'skip' }
  if (located.kind === 'unsafe') return { kind: 'blocked', reason: blockedByUnsafeDescendant(id) }
  const recent = isRecentlyActive(located.location.dir, context.minAgeMinutes)
  if (recent && !context.includeRecent) return { kind: 'blocked', reason: blockedByRecentDescendant(id) }
  return {
    kind: 'deletable',
    item: {
      id,
      location: located.location,
      sizeBytes: dirSizeBytes(located.location.dir),
      recent,
      state: 'exists',
      cascadeSource: context.parentsByChild.get(id)?.[0],
    },
  }
}

/** 已在归档名单内的后代沿用既有结论:同为待删的由主循环处理,不重复纳入级联。 */
function reuseArchivedVerdict(verdict: ArchiveVerdict, id: string): DescendantVerdict {
  if (verdict === 'recent') return { kind: 'blocked', reason: blockedByRecentDescendant(id) }
  if (verdict === 'unsafe') return { kind: 'blocked', reason: blockedByUnsafeDescendant(id) }
  return { kind: 'skip' }
}

/** 构造"后代最近仍有写入"的阻止原因。 */
function blockedByRecentDescendant(childId: string): BlockedReason {
  return { key: 'blockedByRecentDescendant', params: { childId } }
}

/** 构造"后代逃逸出 sessions 根目录"的阻止原因。 */
function blockedByUnsafeDescendant(childId: string): BlockedReason {
  return { key: 'blockedByUnsafeDescendant', params: { childId } }
}

/**
 * 汇总可以从配置中移除的 id:计划判定已不存在的条目,以及本次确实删除成功的会话。
 * 最近活跃被排除与符号链接逃逸被跳过的 id 不参与,它们可能仍在磁盘上。
 */
export function collectGoneSessionIds(plan: CleanPlan, removedIds: Iterable<string>): Set<string> {
  const goneIds = new Set(plan.ghosts.map(item => item.id))
  for (const id of removedIds) goneIds.add(id)
  return goneIds
}
