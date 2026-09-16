/**
 * 程序化 API 入口:面向希望把清理能力嵌入自身脚本的调用方。
 * CLI 与测试同样消费这些导出,保证单一路径的行为一致。
 * @module dsh-clean-sessions
 */

export { resolveDshHome, sessionsRoot, workspaceConfigPath, projectionCacheLegacyDir } from './paths.ts'
export { preflight, readWorkspaceState, updateWorkspaceConfig, validateWorkspaceState } from './config.ts'
export { buildPlan, collectGoneSessionIds } from './plan.ts'
export { applyClean } from './apply.ts'
export { detectRunningDsh } from './detect.ts'
export { formatBytes, findSessionDir, isPathInside, assertBackupDirOutsideHome } from './fsutils.ts'
export { resolveLanguage, makeTranslator, translate } from './i18n.ts'
export { ExitCode, UsageError, ConfigError, PreconditionError, LocalizedError } from './errors.ts'
export type {
  ApplyOptions,
  ApplyOutcome,
  CleanPlan,
  CliOptions,
  ConfigUpdateResult,
  Language,
  SessionLocation,
  SessionPlan,
  WorkspaceState,
} from './types.ts'
