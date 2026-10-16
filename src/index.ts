/**
 * 程序化 API 入口:面向希望把清理能力嵌入自身脚本的调用方。
 * CLI 与测试同样消费这些导出,保证单一路径的行为一致。
 * @module dsh-clean-sessions
 */

export {
  DSH_HOME_ENV,
  attachmentsObjectsDir,
  attachmentsTmpDir,
  encodeSegment,
  expandHomePath,
  normalizeDshHome,
  projectionCacheDir,
  resolveDshHome,
  sessionsRoot,
  workspaceConfigPath,
} from './paths.ts'
export { preflight, readWorkspaceState, updateWorkspaceConfig, validateWorkspaceState } from './config.ts'
export { buildPlan, collectGoneSessionIds } from './plan.ts'
export {
  SUBAGENT_ORIGIN,
  buildSubagentChildIndex,
  collectSubagentAncestors,
  collectSubagentDescendants,
  invertChildIndex,
  normalizeSessionHeader,
  readSessionLogHeader,
} from './cascade.ts'
export {
  ZSTD_LOG_SUFFIX,
  collectLogDigests,
  collectReclaimableObjects,
  measureAttachmentObjects,
  readFrameSpans,
  removeAttachmentObjects,
  subtractDigests,
} from './attachments.ts'
export { applyClean } from './apply.ts'
export { detectRunningDsh } from './detect.ts'
export { formatBytes, findSessionDir, inspectSessionsRoot, isPathInside, assertBackupDirOutsideHome } from './fsutils.ts'
export { resolveLanguage, makeTranslator, translate } from './i18n.ts'
export { ExitCode, UsageError, ConfigError, PreconditionError, LocalizedError } from './errors.ts'
export type { PreflightOptions, PreflightResult } from './config.ts'
export type { ChildIndexResult, HeaderReadResult, SessionHeader } from './cascade.ts'
export type {
  AttachmentObjectMeasure,
  AttachmentRemovalOptions,
  AttachmentRemovalResult,
  FrameSpan,
  FrameSpansResult,
  LogDigestsResult,
  ReclaimableResult,
} from './attachments.ts'
export type { SessionsRootInspection, SessionsRootStatus } from './fsutils.ts'
export type {
  ApplyOptions,
  ApplyOutcome,
  AttachmentReclaimOutcome,
  BlockedReason,
  CleanPlan,
  CliOptions,
  ConfigUpdateResult,
  Language,
  SessionLocation,
  SessionPlan,
  WorkspaceState,
} from './types.ts'
