/**
 * workspace.json 的读取、结构校验与同步更新,以及执行前的前置条件检查。
 * @module dsh-clean-sessions/config
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ConfigUpdateResult, WorkspaceState } from './types.ts'
import { ConfigError, PreconditionError } from './errors.ts'
import { DSH_HOME_ENV, sessionsRoot, workspaceConfigPath } from './paths.ts'
import { atomicWriteJson, inspectSessionsRoot, type SessionsRootStatus } from './fsutils.ts'

/** 前置条件检查的结果,主流程据此决定后续步骤。 */
export interface PreflightResult {
  configPath: string
  sessionsRootDir: string
  sessionsRootExists: boolean
  /** 会话根目录的可用性;未放行时 preflight 已在不可用的情况下抛出异常。 */
  sessionsRootStatus: SessionsRootStatus
}

/** preflight 的可选行为。 */
export interface PreflightOptions {
  /** 会话根目录缺失或不可用时是否放行,默认拒绝。 */
  allowMissingSessions: boolean
}

/** 默认拒绝在会话根目录不可用时继续。 */
const DEFAULT_PREFLIGHT_OPTIONS: PreflightOptions = { allowMissingSessions: false }

/** 校验前置条件:主目录存在、配置文件可读、会话根目录可用,任一不满足即抛 PreconditionError。 */
export function preflight(dshHome: string, options: PreflightOptions = DEFAULT_PREFLIGHT_OPTIONS): PreflightResult {
  if (!existsSync(dshHome) || !statSync(dshHome).isDirectory()) {
    throw new PreconditionError('homeMissing', { path: dshHome, env: DSH_HOME_ENV })
  }
  const configPath = workspaceConfigPath(dshHome)
  if (!existsSync(configPath)) {
    throw new PreconditionError('configMissing', { path: configPath })
  }
  try {
    readFileSync(configPath)
  } catch (error) {
    throw new PreconditionError('configUnreadable', {
      path: configPath,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  const sessionsRootDir = sessionsRoot(dshHome)
  const inspection = inspectSessionsRoot(sessionsRootDir)
  if (inspection.status !== 'usable' && !options.allowMissingSessions) {
    throw inspection.status === 'missing'
      ? new PreconditionError('sessionsRootMissing', { path: sessionsRootDir })
      : new PreconditionError('sessionsRootUnavailable', { path: sessionsRootDir, detail: inspection.detail })
  }
  return {
    configPath,
    sessionsRootDir,
    sessionsRootExists: inspection.status === 'usable',
    sessionsRootStatus: inspection.status,
  }
}

/** 抛出结构无效错误,detail 使用英文技术描述以便于检索。 */
function invalid(detail: string): never {
  throw new ConfigError('configInvalid', { detail })
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断未知值是否为字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** 校验会话 id 不含路径分隔符与相对路径片段,防止畸形 id 拼接出目标目录之外的路径。 */
function assertSafeSessionIds(ids: readonly string[], where: string): void {
  for (const id of ids) {
    const isUnsafe = id.length === 0 || id === '.' || id === '..' || /[/\\:]/.test(id)
    if (isUnsafe) invalid(`${where} contains unsafe session id: ${JSON.stringify(id)}`)
  }
}

/** 校验 workspace.json 的结构,字段缺失或类型不符时抛出 ConfigError。 */
export function validateWorkspaceState(value: unknown): WorkspaceState {
  if (!isRecord(value)) invalid('top level must be an object')
  if (!isRecord(value.unit) || value.unit.name !== 'workspace' || typeof value.unit.version !== 'number') {
    invalid('unit must be { name: "workspace", version: number }')
  }
  if (!isRecord(value.global)) invalid('global must be an object')
  if (typeof value.global.initialized !== 'boolean') invalid('global.initialized must be a boolean')
  if (!isStringArray(value.global.workspaceIds)) invalid('global.workspaceIds must be an array of strings')
  if (value.global.archivedSessionIds !== undefined) {
    if (!isStringArray(value.global.archivedSessionIds)) invalid('global.archivedSessionIds must be an array of strings')
    assertSafeSessionIds(value.global.archivedSessionIds, 'global.archivedSessionIds')
  }
  if (value.global.pinnedSessionIds !== undefined) {
    if (!isStringArray(value.global.pinnedSessionIds)) invalid('global.pinnedSessionIds must be an array of strings')
    assertSafeSessionIds(value.global.pinnedSessionIds, 'global.pinnedSessionIds')
  }
  if (value.global.defaultWorkspaceId !== undefined && typeof value.global.defaultWorkspaceId !== 'string') {
    invalid('global.defaultWorkspaceId must be a string')
  }
  if (!isRecord(value.tables) || !isRecord(value.tables.workspaces)) {
    invalid('tables.workspaces must be an object')
  }
  for (const [workspaceId, record] of Object.entries(value.tables.workspaces)) {
    if (!isRecord(record)) invalid(`tables.workspaces.${workspaceId} must be an object`)
    if (typeof record.path !== 'string' || typeof record.title !== 'string') {
      invalid(`tables.workspaces.${workspaceId} must carry string path and title`)
    }
    if (!isStringArray(record.sessionIds)) invalid(`tables.workspaces.${workspaceId}.sessionIds must be an array of strings`)
    assertSafeSessionIds(record.sessionIds, `tables.workspaces.${workspaceId}.sessionIds`)
    if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
      invalid(`tables.workspaces.${workspaceId} must carry string timestamps`)
    }
  }
  return value as unknown as WorkspaceState
}

/** 读取并校验 workspace.json,文件缺失或内容损坏时抛出异常。 */
export function readWorkspaceState(dshHome: string): WorkspaceState {
  const configPath = workspaceConfigPath(dshHome)
  if (!existsSync(configPath)) {
    throw new PreconditionError('configMissing', { path: configPath })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new ConfigError('configInvalid', {
      detail: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return validateWorkspaceState(parsed)
}

/**
 * 同步配置:从归档名单、工作区槽位与置顶集合中移除调用方已确认消失的会话 id。
 * goneIds 必须来自清理计划与本次删除结果,不得由本函数重新扫盘推断。
 * 未知字段随原对象一并写回,不会被丢弃。
 */
export function updateWorkspaceConfig(dshHome: string, goneIds: ReadonlySet<string>): ConfigUpdateResult {
  const state = readWorkspaceState(dshHome)
  const archivedIds = state.global.archivedSessionIds ?? []
  state.global.archivedSessionIds = archivedIds.filter(id => !goneIds.has(id))
  if (state.global.pinnedSessionIds !== undefined) {
    state.global.pinnedSessionIds = state.global.pinnedSessionIds.filter(id => !goneIds.has(id))
  }
  let slotsRemoved = 0
  for (const record of Object.values(state.tables.workspaces)) {
    const before = record.sessionIds.length
    record.sessionIds = record.sessionIds.filter(id => !goneIds.has(id))
    slotsRemoved += before - record.sessionIds.length
  }
  atomicWriteJson(workspaceConfigPath(dshHome), state)
  return { archivedKept: state.global.archivedSessionIds.length, slotsRemoved }
}
