/**
 * DSH 主目录、会话相关路径与会话目录名的解析,与 dsh-home-paths 包及会话持久化布局保持一致。
 * @module dsh-clean-sessions/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 默认的 DSH 主目录名,与官方约定的 .dsh 一致。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 覆盖默认主目录的环境变量名。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 会话目录名的转义前缀,与 DSH 的 ~XXXX 编码一致。 */
const SEGMENT_ESCAPE_PREFIX = '~'

/** 转义码元的十六进制位数,不足四位时左侧补零。 */
const SEGMENT_ESCAPE_WIDTH = 4

/** 整个目录名恰为单点时使用的转义结果,用于阻断相对路径逃逸。 */
const ENCODED_DOT_SEGMENT = '~002E'

/** 整个目录名恰为双点时使用的转义结果,用于阻断相对路径逃逸。 */
const ENCODED_DOT_DOT_SEGMENT = '~002E~002E'

/** 无需转义的码元集合,与 DSH 的安全字符集一致。 */
const SAFE_CODE_UNIT_PATTERN = /^[A-Za-z0-9._-]$/

/** 返回默认的 DSH 主目录,即用户主目录下的 .dsh。 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/** 展开受支持的波浪号前缀,`~other` 形式不展开,与 DSH 的语义一致。 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 规范化用户给出的主目录:先展开波浪号前缀,再按当前工作目录绝对化。 */
export function normalizeDshHome(raw: string): string {
  return resolve(expandHomePath(raw))
}

/** 解析 DSH 主目录:显式路径优先,其次 $DSH_HOME,最后 ~/.dsh;空白环境变量视为未设置。 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return normalizeDshHome(selected)
}

/**
 * 把一个任意字符串编码成单一安全路径段,逐 UTF-16 码元处理以保留孤立代理项。
 * 会话 id 未经宿主校验,`.`、`..` 与路径分隔符都必须先转义才能用作目录名。
 * 结果与 DSH 的 encodeSegment 逐字一致,可解码还原原始字符串。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return ENCODED_DOT_SEGMENT
  if (raw === '..') return ENCODED_DOT_DOT_SEGMENT
  let encoded = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const codeUnit = String.fromCharCode(code)
    const isSafe = codeUnit !== SEGMENT_ESCAPE_PREFIX && SAFE_CODE_UNIT_PATTERN.test(codeUnit)
    encoded += isSafe
      ? codeUnit
      : `${SEGMENT_ESCAPE_PREFIX}${code.toString(16).toUpperCase().padStart(SEGMENT_ESCAPE_WIDTH, '0')}`
  }
  return encoded
}

/** 返回会话日志根目录,所有会话目录都位于其下。 */
export function sessionsRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

/** 返回归档名单所在的配置文件路径。 */
export function workspaceConfigPath(dshHome: string): string {
  return join(dshHome, 'storages', 'workspace.json')
}

/**
 * 返回投影缓存的 per-record 文档目录,该布局自 2026-08-20 起为当前布局并由宿主按会话维护。
 * 同级的 session_projcache.json 单文件是更早的历史布局,宿主保留但不再维护。
 */
export function projectionCacheDir(dshHome: string): string {
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}
