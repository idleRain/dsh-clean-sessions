/**
 * 文件系统操作:目录定位、体积统计、活跃度判断、安全删除、原子写入。
 * 删除路径包含符号链接逃逸防护与瞬时占用重试,适配 Windows 文件占用场景。
 * @module dsh-clean-sessions/fsutils
 */

import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Dirent,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionLocation, SessionPlan } from './types.ts'
import { PreconditionError } from './errors.ts'
import { encodeSegment } from './paths.ts'

/** 删除目录的最大重试次数,应对文件被进程瞬时占用的情况。 */
export const DELETE_RETRY_COUNT = 3

/** 删除重试之间的等待毫秒数,避免忙等占用系统资源。 */
export const DELETE_RETRY_DELAY_MILLIS = 200

/** 一分钟包含的毫秒数,用于把文件修改时间换算成分钟级间隔。 */
const MILLIS_PER_MINUTE = 60_000

/** 字节换算的进制,与文件系统大小单位约定保持一致。 */
const BYTES_PER_KIB = 1024

/** 千字节换算的进制,与文件系统大小单位约定保持一致。 */
const BYTES_PER_MIB = 1024 * 1024

/** 可视为瞬时占用的错误码集合,Windows 下文件被进程打开时常见。 */
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

/** 把字节数格式化为可读的大小字符串。 */
export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_KIB) return `${bytes} B`
  if (bytes < BYTES_PER_MIB) return `${(bytes / BYTES_PER_KIB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MIB).toFixed(2)} MB`
}

/** 返回路径的 realpath 结果,解析失败时返回 null。 */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** 判断目标路径是否位于根路径之内,不跟随符号链接,纯字符串比较。 */
export function isPathInside(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 校验备份目录不位于 DSH 主目录之内,防止备份数据混入会话扫描范围。 */
export function assertBackupDirOutsideHome(backupDir: string, dshHome: string): void {
  const plainInside = backupDir === dshHome || isPathInside(resolve(backupDir), resolve(dshHome))
  const homeReal = realpathOrNull(dshHome)
  const backupReal = realpathOrNull(backupDir)
  const realInside = homeReal !== null && backupReal !== null && isPathInside(backupReal, homeReal)
  if (plainInside || realInside) {
    throw new PreconditionError('backupInsideHome', { backup: backupDir, home: dshHome })
  }
}

/** sessions 根目录的可用性状态,用于区分"不存在"与"读不到"。 */
export type SessionsRootStatus = 'usable' | 'missing' | 'unavailable'

/** sessions 根目录的探测结果,不可用时携带底层错误或原因描述。 */
export interface SessionsRootInspection {
  status: SessionsRootStatus
  detail: string
}

/** 判断错误是否表示路径确实不存在,其余错误码一律视为不可核实。 */
function isAbsentError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 把未知错误转成可展示的字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 探测 sessions 根目录是否可用,无法枚举的目录不会被当作"不存在"。 */
export function inspectSessionsRoot(sessionsRootDir: string): SessionsRootInspection {
  try {
    if (!statSync(sessionsRootDir).isDirectory()) {
      return { status: 'unavailable', detail: 'path exists but is not a directory' }
    }
    readdirSync(sessionsRootDir)
    return { status: 'usable', detail: '' }
  } catch (error) {
    return isAbsentError(error)
      ? { status: 'missing', detail: '' }
      : { status: 'unavailable', detail: describeError(error) }
  }
}

/**
 * 在 sessions 根目录下按项目分组查找某个会话目录。
 * 返回 undefined 仅表示已确认不存在;根目录与候选路径读不到时抛出前置条件错误终止流程。
 */
export function findSessionDir(sessionsRootDir: string, sessionId: string): SessionLocation | undefined {
  const dirName = encodeSegment(sessionId)
  for (const projectEntry of listProjectEntries(sessionsRootDir)) {
    const candidate = join(sessionsRootDir, projectEntry.name, dirName)
    if (isSessionDir(candidate)) return { dir: candidate, projectDir: projectEntry.name }
  }
  return undefined
}

/** 列出 sessions 根目录下的项目分组,根目录缺失或不可读时抛出前置条件错误。 */
function listProjectEntries(sessionsRootDir: string): Dirent[] {
  try {
    return readdirSync(sessionsRootDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
  } catch (error) {
    const key = isAbsentError(error) ? 'sessionsRootMissing' : 'sessionsRootUnavailable'
    throw new PreconditionError(key, { path: sessionsRootDir, detail: describeError(error) })
  }
}

/** 探测候选会话目录是否存在,仅 ENOENT 视为不存在,其余错误视为不可核实并抛出。 */
function isSessionDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch (error) {
    if (isAbsentError(error)) return false
    throw new PreconditionError('sessionDirUnverifiable', { path: candidate, detail: describeError(error) })
  }
}

/** 递归累加目录内全部文件的总字节数,目录不可读时返回 null 表示大小未知。 */
export function dirSizeBytes(dir: string): number | null {
  let totalBytes = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        totalBytes += statSync(fullPath).size
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return null
  }
  return totalBytes
}

/** 计算目录内最新一次文件写入距离当前时间的分钟数,目录内没有文件时返回 null,目录不可读时抛出异常。 */
export function latestWriteMinutesAgo(dir: string): number | null {
  let latestWriteMillis = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        latestWriteMillis = Math.max(latestWriteMillis, statSync(fullPath).mtimeMs)
      }
    }
  }
  walk(dir)
  if (latestWriteMillis === 0) return null
  return (Date.now() - latestWriteMillis) / MILLIS_PER_MINUTE
}

/**
 * 判断一个会话目录是否在指定间隔内有写入。
 * 目录不可读时按可能活跃处理,避免把正在写入的会话误判为可删除。
 */
export function isRecentlyActive(dir: string, minAgeMinutes: number): boolean {
  if (minAgeMinutes <= 0) return false
  try {
    const minutes = latestWriteMinutesAgo(dir)
    return minutes !== null && minutes < minAgeMinutes
  } catch {
    return true
  }
}

/** 同步睡眠指定毫秒数,用于删除重试之间的退避。 */
function sleepSync(millis: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis)
}

/**
 * 执行一次删除动作,对瞬时占用错误做有限次重试。
 * 非瞬时错误与重试耗尽都会抛出,由调用方决定记录后继续还是中断流程。
 */
function removeWithRetry(action: () => void): void {
  for (let attempt = 1; attempt <= DELETE_RETRY_COUNT; attempt++) {
    try {
      action()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined || !TRANSIENT_LOCK_CODES.has(code) || attempt === DELETE_RETRY_COUNT) {
        throw error
      }
      sleepSync(DELETE_RETRY_DELAY_MILLIS)
    }
  }
}

/** 递归删除目录,对瞬时占用错误做有限次重试,最终失败时抛出最后一个错误。 */
export function removeDirWithRetry(dir: string): void {
  removeWithRetry(() => rmSync(dir, { recursive: true, force: true }))
}

/** 删除或移动一个会话目录;移动时先尝试 rename,跨卷失败则复制后删除原目录。 */
export function removeSessionDir(item: SessionPlan, backupDir: string | undefined): void {
  if (item.location === undefined) return
  if (backupDir === undefined) {
    removeDirWithRetry(item.location.dir)
    return
  }
  const destination = join(backupDir, item.location.projectDir, item.id)
  mkdirSync(dirname(destination), { recursive: true })
  try {
    renameSync(item.location.dir, destination)
  } catch {
    // 跨卷移动时 rename 会抛出异常,退化为复制目录后删除原目录
    cpSync(item.location.dir, destination, { recursive: true })
    removeDirWithRetry(item.location.dir)
  }
}

/** 投影缓存文档的清理结果,失败项以列表返回供调用方汇总。 */
export interface ProjectionCacheCleanResult {
  cleanedCount: number
  failures: string[]
}

/**
 * 删除投影缓存中与指定 id 对应的 per-record 文档。
 * 单项删除失败记入 failures 而不抛出,避免中断其后的配置同步。
 */
export function cleanProjectionCache(
  projectionCacheDir: string,
  removedIds: ReadonlySet<string>,
): ProjectionCacheCleanResult {
  let cleanedCount = 0
  const failures: string[] = []
  for (const id of removedIds) {
    const documentPath = join(projectionCacheDir, `${id}.json`)
    if (!existsSync(documentPath)) continue
    try {
      removeWithRetry(() => rmSync(documentPath, { force: true }))
      cleanedCount += 1
    } catch (error) {
      failures.push(`projection cache ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { cleanedCount, failures }
}

/** 移除 sessions 根目录下已经完全为空的项目分组,返回被移除的分组名。 */
export function removeEmptyProjectDirs(sessionsRootDir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(sessionsRootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = join(sessionsRootDir, entry.name)
    let children: Dirent[]
    try {
      children = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      // 分组目录不可读时保持原样,交由用户人工检查
      continue
    }
    // 仅移除完全为空的分组,仅含散文件的分组保留原样,避免误删未知来源的文件
    if (children.length === 0) {
      removeDirWithRetry(projectDir)
      removed.push(entry.name)
    }
  }
  return removed
}

/** 以临时文件加 fsync 加 rename 的方式原子写入 JSON,写入后重新解析以确认内容可读。 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  const handle = openSync(temporaryPath, 'w')
  try {
    writeSync(handle, content)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporaryPath, filePath)
  JSON.parse(readFileSync(filePath, 'utf8'))
}
