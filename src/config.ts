/**
 * workspace.json 的读取、结构校验与同步更新,以及执行前的前置条件检查。
 * @module dsh-clean-sessions/config
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ConfigUpdateResult, WorkspaceState } from './types.ts'
import { ConfigError, PreconditionError } from './errors.ts'
import { sessionsRoot, workspaceConfigPath } from './paths.ts'
import { atomicWriteJson } from './fsutils.ts'
import { collectGoneSessionIds } from './plan.ts'

/** 前置条件检查的结果,主流程据此决定后续步骤。 */
export interface PreflightResult {
  configPath: string
  sessionsRootDir: string
  sessionsRootExists: boolean
}

/** 校验前置条件:主目录存在、配置文件存在且可读,缺一即抛 PreconditionError。 */
export function preflight(dshHome: string): PreflightResult {
  if (!existsSync(dshHome) || !statSync(dshHome).isDirectory()) {
    throw new PreconditionError('homeMissing', { path: dshHome, env: 'DSH_HOME' })
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
  const sessionsRootExists = existsSync(sessionsRootDir) && statSync(sessionsRootDir).isDirectory()
  return { configPath, sessionsRootDir, sessionsRootExists }
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

/** 同步配置:从归档名单与各工作区槽位中移除磁盘上已不存在的会话 id。 */
export function updateWorkspaceConfig(dshHome: string): ConfigUpdateResult {
  const state = readWorkspaceState(dshHome)
  const archivedIds = state.global.archivedSessionIds ?? []
  const goneIds = collectGoneSessionIds(dshHome, archivedIds)
  state.global.archivedSessionIds = archivedIds.filter(id => !goneIds.has(id))
  let slotsRemoved = 0
  for (const record of Object.values(state.tables.workspaces)) {
    const before = record.sessionIds.length
    record.sessionIds = record.sessionIds.filter(id => !goneIds.has(id))
    slotsRemoved += before - record.sessionIds.length
  }
  atomicWriteJson(workspaceConfigPath(dshHome), state)
  return { archivedKept: state.global.archivedSessionIds.length, slotsRemoved }
}
