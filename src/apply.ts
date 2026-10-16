/**
 * 清理执行的编排:删除会话目录、回收附件对象、清理投影缓存、移除空分组、同步配置。
 * 单项失败不会中断整体流程,而是进入 failures 列表供调用方汇总。
 * @module dsh-clean-sessions/apply
 */

import { assertBackupDirOutsideHome, cleanProjectionCache, removeEmptyProjectDirs, removeSessionDir } from './fsutils.ts'
import { projectionCacheDir, sessionsRoot } from './paths.ts'
import { collectReclaimableObjects, removeAttachmentObjects, subtractDigests } from './attachments.ts'
import { collectGoneSessionIds } from './plan.ts'
import { updateWorkspaceConfig } from './config.ts'
import type {
  ApplyOptions,
  ApplyOutcome,
  AttachmentReclaimOutcome,
  CleanPlan,
  ConfigUpdateResult,
  SessionPlan,
} from './types.ts'
import type { ReclaimableResult } from './attachments.ts'

/** 把未知错误转成可展示的字符串。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 同步 workspace.json 配置,失败时记录错误而不中断整体流程。 */
function syncConfigQuietly(
  dshHome: string,
  updateConfig: boolean,
  goneIds: ReadonlySet<string>,
): { configResult?: ConfigUpdateResult; configError?: string } {
  if (!updateConfig) return {}
  try {
    return { configResult: updateWorkspaceConfig(dshHome, goneIds) }
  } catch (error) {
    // 配置同步失败时保留错误信息,已完成的删除成果仍需正常输出
    return { configError: errorMessage(error) }
  }
}

/** 执行清理计划:按序删除待删会话与级联后代、回收附件对象、清理缓存、移除空分组并同步配置。 */
export function applyClean(dshHome: string, plan: CleanPlan, options: ApplyOptions): ApplyOutcome {
  if (options.backupDir !== undefined) {
    assertBackupDirOutsideHome(options.backupDir, dshHome)
  }
  const deletion = [...plan.toDelete, ...plan.cascade]
  const deletedIds = new Set(deletion.map(item => item.id))
  const candidates = collectAttachmentCandidates(dshHome, deletedIds, options)
  const { failures, removedIds } = removeSessions(deletion, options.backupDir)
  const attachments = reclaimAttachments(dshHome, deletedIds, removedIds, candidates, options)
  const cascadeIds = new Set(plan.cascade.map(item => item.id))
  const cascadeRemovedCount = [...removedIds].filter(id => cascadeIds.has(id)).length
  const goneIds = collectGoneSessionIds(plan, removedIds)
  const cacheResult = cleanProjectionCache(projectionCacheDir(dshHome), goneIds)
  const emptiedProjects = removeEmptyProjectDirs(sessionsRoot(dshHome))
  const { configResult, configError } = syncConfigQuietly(dshHome, options.updateConfig, goneIds)
  return {
    removedCount: removedIds.size,
    cascadeRemovedCount,
    failures: [...failures, ...cacheResult.failures],
    cleanedCacheCount: cacheResult.cleanedCount,
    emptiedProjects,
    configResult,
    configError,
    attachments,
  }
}

/** 逐个删除待删会话,单项失败记入列表而不中断后续删除。 */
function removeSessions(
  deletion: readonly SessionPlan[],
  backupDir: string | undefined,
): { failures: string[]; removedIds: Set<string> } {
  const failures: string[] = []
  const removedIds = new Set<string>()
  for (const item of deletion) {
    try {
      removeSessionDir(item, backupDir)
      removedIds.add(item.id)
    } catch (error) {
      failures.push(`${item.id}: ${errorMessage(error)}`)
    }
  }
  return { failures, removedIds }
}

/**
 * 删除前收集待删会话引用的候选摘要。
 * 会话目录一经删除其日志不可再读,因此候选集合必须在删除前取得。
 */
function collectAttachmentCandidates(
  dshHome: string,
  deletedIds: ReadonlySet<string>,
  options: ApplyOptions,
): ReclaimableResult | undefined {
  if (options.keepAttachments === true || deletedIds.size === 0) return undefined
  return collectReclaimableObjects(dshHome, deletedIds)
}

/**
 * 回收附件对象:候选摘要扣除删除后仍在磁盘上的待删会话引用。
 * 引用无法确认或删除未发生任何成功时整体跳过,不影响会话删除与配置同步的既有结果。
 */
function reclaimAttachments(
  dshHome: string,
  deletedIds: ReadonlySet<string>,
  removedIds: ReadonlySet<string>,
  candidates: ReclaimableResult | undefined,
  options: ApplyOptions,
): AttachmentReclaimOutcome | undefined {
  if (candidates === undefined) return undefined
  if (candidates.kind === 'aborted') return skippedReclaim(candidates.reason)
  if (removedIds.size === 0) return emptyReclaim()
  // 删除失败的会话仍留在磁盘上,其引用必须重新计入存活侧
  const residual = collectReclaimableObjects(dshHome, deletedIds)
  if (residual.kind === 'aborted') return skippedReclaim(residual.reason)
  const digests = subtractDigests(candidates.digests, residual.digests)
  if (digests.size === 0) return emptyReclaim()
  const removal = removeAttachmentObjects(
    dshHome,
    digests,
    options.backupDir === undefined ? {} : { backupDir: options.backupDir },
  )
  return { removedCount: removal.removed, removedBytes: removal.bytes, failures: removal.failures }
}

/** 构造"本次未回收任何对象"的结果。 */
function emptyReclaim(): AttachmentReclaimOutcome {
  return { removedCount: 0, removedBytes: 0, failures: [] }
}

/** 构造"整体跳过回收"的结果,原因由 CLI 原样展示。 */
function skippedReclaim(reason: string): AttachmentReclaimOutcome {
  return { removedCount: 0, removedBytes: 0, skippedReason: reason, failures: [] }
}
