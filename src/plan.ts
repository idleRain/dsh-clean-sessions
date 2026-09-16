/**
 * 清理计划的构建:把归档 id 名单按磁盘状态、活跃度与路径安全性归类。
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
import type { CleanPlan, SessionPlan } from './types.ts'

/** 把归档 id 名单展开成清理计划,按磁盘状态与活跃度归类。 */
export function buildPlan(
  dshHome: string,
  archivedIds: readonly string[],
  minAgeMinutes: number,
  includeRecent: boolean,
): CleanPlan {
  const root = sessionsRoot(dshHome)
  const rootReal = realpathOrNull(root)
  const toDelete: SessionPlan[] = []
  const recentExcluded: SessionPlan[] = []
  const ghosts: SessionPlan[] = []
  const unsafe: SessionPlan[] = []
  for (const id of archivedIds) {
    const location = findSessionDir(root, id)
    if (location === undefined) {
      ghosts.push({ id, sizeBytes: 0, recent: false, state: 'ghost' })
      continue
    }
    // 符号链接或联接逃逸防护:目录解析结果必须位于 sessions 根目录之内
    const dirReal = rootReal === null ? null : realpathOrNull(location.dir)
    if (rootReal !== null && (dirReal === null || !isPathInside(dirReal, rootReal))) {
      unsafe.push({ id, location, sizeBytes: dirSizeBytes(location.dir), recent: false, state: 'exists' })
      continue
    }
    const recent = isRecentlyActive(location.dir, minAgeMinutes)
    const item: SessionPlan = { id, location, sizeBytes: dirSizeBytes(location.dir), recent, state: 'exists' }
    if (recent && !includeRecent) {
      recentExcluded.push(item)
    } else {
      toDelete.push(item)
    }
  }
  return { toDelete, recentExcluded, ghosts, unsafe }
}

/** 收集归档名单中磁盘目录已不存在的 id,包含本次删除的会话与历史幽灵条目。 */
export function collectGoneSessionIds(dshHome: string, archivedIds: readonly string[]): Set<string> {
  const root = sessionsRoot(dshHome)
  const goneIds = new Set<string>()
  for (const id of archivedIds) {
    if (findSessionDir(root, id) === undefined) goneIds.add(id)
  }
  return goneIds
}
