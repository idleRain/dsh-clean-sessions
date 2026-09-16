/**
 * 清理执行的编排:删除会话目录、清理缓存遗留、移除空分组、同步配置。
 * 单项失败不会中断整体流程,而是进入 failures 列表供调用方汇总。
 * @module dsh-clean-sessions/apply
 */

import { assertBackupDirOutsideHome, cleanProjectionCacheLegacy, removeEmptyProjectDirs, removeSessionDir } from './fsutils.ts'
import { projectionCacheLegacyDir, sessionsRoot } from './paths.ts'
import { collectGoneSessionIds } from './plan.ts'
import { updateWorkspaceConfig } from './config.ts'
import type { ApplyOptions, ApplyOutcome, CleanPlan, ConfigUpdateResult } from './types.ts'

/** 把未知错误转成可展示的字符串。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 同步 workspace.json 配置,失败时记录错误而不中断整体流程。 */
function syncConfigQuietly(dshHome: string, updateConfig: boolean): { configResult?: ConfigUpdateResult; configError?: string } {
  if (!updateConfig) return {}
  try {
    return { configResult: updateWorkspaceConfig(dshHome) }
  } catch (error) {
    // 配置同步失败时保留错误信息,已完成的删除成果仍需正常输出
    return { configError: errorMessage(error) }
  }
}

/** 执行清理计划:按序删除会话、清理缓存、移除空分组并同步配置。 */
export function applyClean(
  dshHome: string,
  archivedIds: readonly string[],
  plan: CleanPlan,
  options: ApplyOptions,
): ApplyOutcome {
  if (options.backupDir !== undefined) {
    assertBackupDirOutsideHome(options.backupDir, dshHome)
  }
  const failures: string[] = []
  let removedCount = 0
  for (const item of plan.toDelete) {
    try {
      removeSessionDir(item, options.backupDir)
      removedCount += 1
    } catch (error) {
      failures.push(`${item.id}: ${errorMessage(error)}`)
    }
  }
  const removedIds = collectGoneSessionIds(dshHome, archivedIds)
  const cleanedCacheCount = cleanProjectionCacheLegacy(dshHome, projectionCacheLegacyDir(dshHome), removedIds)
  const emptiedProjects = removeEmptyProjectDirs(sessionsRoot(dshHome))
  const { configResult, configError } = syncConfigQuietly(dshHome, options.updateConfig)
  return { removedCount, failures, cleanedCacheCount, emptiedProjects, configResult, configError }
}
