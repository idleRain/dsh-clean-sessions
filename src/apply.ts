/**
 * 清理执行的编排:删除会话目录、清理投影缓存、移除空分组、同步配置。
 * 单项失败不会中断整体流程,而是进入 failures 列表供调用方汇总。
 * @module dsh-clean-sessions/apply
 */

import { assertBackupDirOutsideHome, cleanProjectionCache, removeEmptyProjectDirs, removeSessionDir } from './fsutils.ts'
import { projectionCacheDir, sessionsRoot } from './paths.ts'
import { collectGoneSessionIds } from './plan.ts'
import { updateWorkspaceConfig } from './config.ts'
import type { ApplyOptions, ApplyOutcome, CleanPlan, ConfigUpdateResult } from './types.ts'

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

/** 执行清理计划:按序删除会话、清理缓存、移除空分组并同步配置。 */
export function applyClean(dshHome: string, plan: CleanPlan, options: ApplyOptions): ApplyOutcome {
  if (options.backupDir !== undefined) {
    assertBackupDirOutsideHome(options.backupDir, dshHome)
  }
  const failures: string[] = []
  const removedIds = new Set<string>()
  for (const item of plan.toDelete) {
    try {
      removeSessionDir(item, options.backupDir)
      removedIds.add(item.id)
    } catch (error) {
      failures.push(`${item.id}: ${errorMessage(error)}`)
    }
  }
  const goneIds = collectGoneSessionIds(plan, removedIds)
  const cleanedCacheCount = cleanProjectionCache(projectionCacheDir(dshHome), goneIds)
  const emptiedProjects = removeEmptyProjectDirs(sessionsRoot(dshHome))
  const { configResult, configError } = syncConfigQuietly(dshHome, options.updateConfig, goneIds)
  return { removedCount: removedIds.size, failures, cleanedCacheCount, emptiedProjects, configResult, configError }
}
