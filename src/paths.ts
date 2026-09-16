/**
 * DSH 主目录与会话相关路径的解析,与 dsh-home-paths 包的约定保持一致。
 * @module dsh-clean-sessions/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认的 DSH 主目录名,与官方约定的 .dsh 一致。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 覆盖默认主目录的环境变量名。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 解析 DSH 主目录:优先使用 DSH_HOME 环境变量,空白值视为未设置。 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/** 返回会话日志根目录,所有会话目录都位于其下。 */
export function sessionsRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

/** 返回归档名单所在的配置文件路径。 */
export function workspaceConfigPath(dshHome: string): string {
  return join(dshHome, 'storages', 'workspace.json')
}

/** 返回投影缓存旧 per-record 遗留文档所在目录,宿主不再管理该目录。 */
export function projectionCacheLegacyDir(dshHome: string): string {
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}
