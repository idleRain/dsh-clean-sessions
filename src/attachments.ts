/**
 * 附件对象回收:按会话日志中的摘要字面引用做引用计数,回收只被待删会话引用的内容寻址对象。
 * 会话日志 .jsonl.zstd 是按记录逐帧拼接的 zstd 容器,必须按帧头与块头结构推进定位帧边界,
 * 再用公开的 zstdDecompressSync 逐帧解压;流式接口只解出首个帧,裸搜魔数则会把压缩数据里的
 * 巧合字节当成帧起点,两者都不能用于这个容器。帧边界判定由 ./zstdFrames.ts 统一提供。
 * 本模块不触碰 attachments/v1/request-images 与 cache/attachments/request-images:它们的叶子名
 * 是请求装配期计算的 variantId,该值不落库、在真实会话日志中出现 0 次,无法做引用计数,
 * 且它们是由 objects 重建的派生缓存。
 * 本模块也不触碰 llm-deepseek/files-v3.json:那是会话日志之外的全局上传映射,不带会话归属。
 * @module dsh-clean-sessions/attachments
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isPathInside, realpathOrNull } from './fsutils.ts'
import { attachmentsObjectsDir, attachmentsTmpDir, encodeSegment, sessionsRoot } from './paths.ts'
import { advanceOneFrame } from './zstdFrames.ts'

/** 压缩会话日志的文件名后缀。 */
export const ZSTD_LOG_SUFFIX = '.zstd'

/** 规范会话日志文件名:session.jsonl 或 session.vN.jsonl,可带压缩后缀。 */
const SESSION_LOG_NAME_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

/** 内容寻址对象摘要的叶子名形态。 */
const DIGEST_NAME_PATTERN = /^[0-9a-f]{64}$/

/** 会话日志中附件引用的字面形态,尾随的负向前瞻避免把更长十六进制串的前缀当作摘要。 */
const REFERENCE_PATTERN = /sha256:([0-9a-f]{64})(?![0-9a-f])/g

/** 分片目录名的字符数,取摘要前缀。 */
const SHARD_NAME_LENGTH = 2

/** 备份目录内附件对象的相对路径段。 */
const BACKUP_OBJECT_SEGMENTS = ['attachments', 'objects'] as const

/** 对象发布时设置的只读权限,删除前放宽以便不依赖平台对只读属性的重试行为。 */
const OBJECT_REMOVABLE_MODE = 0o600

/** 空会话 id 集合,用于没有显式保留名单的调用。 */
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set()

/** 一帧在文件中的字节区间,start 含、end 不含。 */
export interface FrameSpan {
  start: number
  end: number
}

/** 帧边界扫描结果,failed 表示日志结构不可信。 */
export type FrameSpansResult = { kind: 'ok'; spans: FrameSpan[] } | { kind: 'failed'; reason: string }

/** 单份日志的摘要收集结果,failed 表示引用无法完整收集。 */
export type LogDigestsResult = { kind: 'ok'; digests: Set<string> } | { kind: 'failed'; reason: string }

/** 引用计数结果,aborted 表示存在无法确认的引用,本次不得回收任何对象。 */
export type ReclaimableResult =
  | { kind: 'ok'; digests: Set<string> }
  | { kind: 'aborted'; reason: string }

/** 附件对象存储的统计结果。 */
export interface AttachmentObjectMeasure {
  count: number
  bytes: number
}

/** 附件对象移除的汇总,单项失败不中断整体流程。 */
export interface AttachmentRemovalResult {
  removed: number
  bytes: number
  failures: string[]
}

/** 移除附件对象的选项,提供备份目录时对象被移动而非删除。 */
export interface AttachmentRemovalOptions {
  backupDir?: string
}

/** 已定位对象的信息。 */
interface LocatedObject {
  path: string
  bytes: number
}

/** 对象文件的定位结果,outside 表示解析后的真实路径逃逸出存储根。 */
type ObjectLocation =
  | { kind: 'found'; path: string; bytes: number }
  | { kind: 'absent' }
  | { kind: 'outside'; resolved: string }

/** 单个对象的处置结果。 */
type ObjectRemoval =
  | { kind: 'removed'; bytes: number }
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string }

/** 目录枚举结果,失败时携带带路径的原因。 */
type DirectoryRead = { kind: 'ok'; entries: Dirent[] } | { kind: 'failed'; reason: string }

/** 会话目录条目。 */
interface SessionDirEntry {
  path: string
  name: string
}

/** 会话目录清点结果。 */
type SessionDirsResult = { kind: 'ok'; dirs: SessionDirEntry[] } | { kind: 'failed'; reason: string }

/** 会话引用扫描结果。 */
type ReferenceScan = { kind: 'ok'; deleted: Set<string>; kept: Set<string> } | { kind: 'aborted'; reason: string }

/** 读取整份日志并按帧结构定位边界,缓冲区随结果返回供逐帧解码复用。 */
type FrameBufferResult =
  | { kind: 'ok'; buffer: Buffer; spans: FrameSpan[] }
  | { kind: 'failed'; reason: string }

/** 把未知错误转成可展示的字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 按 zstd 帧结构定位日志文件中每一帧的字节区间。 */
export function readFrameSpans(file: string): FrameSpansResult {
  const frames = readFrameBuffer(file)
  return frames.kind === 'failed' ? frames : { kind: 'ok', spans: frames.spans }
}

/** 读取整份日志并定位全部帧边界,空文件与截断尾帧一律判定为不可信。 */
function readFrameBuffer(file: string): FrameBufferResult {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return { kind: 'failed', reason: `cannot read ${file}: ${describeError(error)}` }
  }
  // 规范日志恒以头帧开头,零字节说明写入未完成或已被截断,引用无法确认
  if (buffer.length === 0) return { kind: 'failed', reason: `${file} is empty` }
  const spans = scanFrameSpans(buffer)
  if (spans.kind === 'failed') return { kind: 'failed', reason: `${file}: ${spans.reason}` }
  return { kind: 'ok', buffer, spans: spans.spans }
}

/** 顺序推进定位全部帧,任一帧结构非法或尾部截断都判定整份日志不可信。 */
function scanFrameSpans(buffer: Buffer): FrameSpansResult {
  const spans: FrameSpan[] = []
  let offset = 0
  while (offset < buffer.length) {
    const advance = advanceOneFrame(buffer, offset)
    if (advance.kind === 'torn') return { kind: 'failed', reason: `truncated zstd frame at byte ${offset}` }
    if (advance.kind === 'invalid') return { kind: 'failed', reason: advance.reason }
    spans.push({ start: offset, end: advance.end })
    offset = advance.end
  }
  return { kind: 'ok', spans }
}

/** 收集一份会话日志中的全部附件摘要字面引用,支持压缩与未压缩两种日志。 */
export function collectLogDigests(file: string): LogDigestsResult {
  return file.endsWith(ZSTD_LOG_SUFFIX) ? collectCompressedLogDigests(file) : collectPlainLogDigests(file)
}

/** 逐帧解压压缩日志并收集摘要,每一帧的明文在处理完后即释放。 */
function collectCompressedLogDigests(file: string): LogDigestsResult {
  const frames = readFrameBuffer(file)
  if (frames.kind === 'failed') return frames
  const digests = new Set<string>()
  for (const span of frames.spans) {
    let text: string
    try {
      text = zstdDecompressSync(frames.buffer.subarray(span.start, span.end)).toString('utf8')
    } catch (error) {
      return { kind: 'failed', reason: `${file}: cannot decode frame at byte ${span.start}: ${describeError(error)}` }
    }
    collectLiteralDigests(text, digests)
  }
  return { kind: 'ok', digests }
}

/** 逐行读取未压缩日志并收集摘要,空文件同样判定为不可信。 */
function collectPlainLogDigests(file: string): LogDigestsResult {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: 'failed', reason: `cannot read ${file}: ${describeError(error)}` }
  }
  if (content.length === 0) return { kind: 'failed', reason: `${file} is empty` }
  const digests = new Set<string>()
  for (const line of content.split('\n')) collectLiteralDigests(line, digests)
  return { kind: 'ok', digests }
}

/** 收集文本中的全部摘要,只做字面匹配以保持对日志格式版本无关。 */
function collectLiteralDigests(text: string, into: Set<string>): void {
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const digest = match[1]
    if (digest !== undefined) into.add(digest)
  }
}

/** 求 first 中不在 second 中的摘要。 */
export function subtractDigests(first: ReadonlySet<string>, second: ReadonlySet<string>): Set<string> {
  const result = new Set<string>()
  for (const digest of first) {
    if (!second.has(digest)) result.add(digest)
  }
  return result
}

/**
 * 计算只被待删会话引用的对象摘要。
 * 会话按目录名分组,命中待删 id 且不在保留名单内的目录计入待删集合,其余目录一律按存活处理。
 * 任一目录的日志无法完整收集时返回 aborted,由调用方放弃本次回收。
 */
export function collectReclaimableObjects(
  dshHome: string,
  deletedIds: ReadonlySet<string>,
  keepIds: ReadonlySet<string> = EMPTY_SESSION_IDS,
): ReclaimableResult {
  if (deletedIds.size === 0) return { kind: 'ok', digests: new Set() }
  const pendingWrites = describePendingWrites(attachmentsTmpDir(dshHome))
  if (pendingWrites !== undefined) return { kind: 'aborted', reason: pendingWrites }
  const scan = scanSessionReferences(sessionsRoot(dshHome), deletedIds, keepIds)
  if (scan.kind === 'aborted') return scan
  return { kind: 'ok', digests: subtractDigests(scan.deleted, scan.kept) }
}

/** 探测暂存目录是否有正在进行的写入,返回非 undefined 时本次回收必须放弃。 */
function describePendingWrites(tmpDir: string): string | undefined {
  if (!existsSync(tmpDir)) return undefined
  const entries = readDirectory(tmpDir)
  if (entries.kind === 'failed') return `${entries.reason}; cannot confirm no attachment write is in flight`
  if (entries.entries.length > 0) {
    return `${tmpDir} holds ${entries.entries.length} entry(ies); an attachment write may be in flight`
  }
  return undefined
}

/** 遍历全部会话目录,按目录名分成待删与存活两组并收集各自的引用摘要。 */
function scanSessionReferences(
  sessionsRootDir: string,
  deletedIds: ReadonlySet<string>,
  keepIds: ReadonlySet<string>,
): ReferenceScan {
  const listed = listSessionDirs(sessionsRootDir)
  if (listed.kind === 'failed') return { kind: 'aborted', reason: listed.reason }
  const deletedNames = encodeSessionNames(deletedIds)
  const keptNames = encodeSessionNames(keepIds)
  const deleted = new Set<string>()
  const kept = new Set<string>()
  for (const sessionDir of listed.dirs) {
    const digests = collectSessionDirDigests(sessionDir.path)
    if (digests.kind === 'failed') return { kind: 'aborted', reason: digests.reason }
    const target = isDeletedSessionDir(sessionDir.name, deletedNames, keptNames) ? deleted : kept
    for (const digest of digests.digests) target.add(digest)
  }
  return { kind: 'ok', deleted, kept }
}

/** 把会话 id 编码成 DSH 使用的目录名,空 id 无法编码时跳过。 */
function encodeSessionNames(ids: ReadonlySet<string>): Set<string> {
  const names = new Set<string>()
  for (const id of ids) {
    if (id.length > 0) names.add(encodeSegment(id))
  }
  return names
}

/** 判断会话目录是否属于待删集合;保留名单优先于待删名单。 */
function isDeletedSessionDir(
  dirName: string,
  deletedNames: ReadonlySet<string>,
  keptNames: ReadonlySet<string>,
): boolean {
  return deletedNames.has(dirName) && !keptNames.has(dirName)
}

/** 收集一个会话目录内全部代次日志的引用摘要,缺少规范日志时引用未知。 */
function collectSessionDirDigests(sessionDir: string): LogDigestsResult {
  const entries = readDirectory(sessionDir)
  if (entries.kind === 'failed') return { kind: 'failed', reason: entries.reason }
  const paths = entries.entries
    .filter(entry => SESSION_LOG_NAME_PATTERN.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
    .map(entry => join(sessionDir, entry.name))
  if (paths.length === 0) return { kind: 'failed', reason: `no canonical session log in ${sessionDir}` }
  return collectLogFilesDigests(paths)
}

/** 合并多份日志的摘要集合,任一份失败即整体失败。 */
function collectLogFilesDigests(paths: readonly string[]): LogDigestsResult {
  const digests = new Set<string>()
  for (const path of paths) {
    const result = collectLogDigests(path)
    if (result.kind === 'failed') return { kind: 'failed', reason: result.reason }
    for (const digest of result.digests) digests.add(digest)
  }
  return { kind: 'ok', digests }
}

/**
 * 列出会话根下的全部会话目录,任一层不可读时返回失败原因。
 * 分组目录与其中的条目都接受符号链接,以便由目标自身的读取结果决定是否可信。
 */
function listSessionDirs(sessionsRootDir: string): SessionDirsResult {
  const projects = readDirectory(sessionsRootDir)
  if (projects.kind === 'failed') return projects
  const dirs: SessionDirEntry[] = []
  for (const project of projects.entries) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue
    const projectDir = join(sessionsRootDir, project.name)
    const sessions = readDirectory(projectDir)
    if (sessions.kind === 'failed') return sessions
    dirs.push(...toSessionDirEntries(projectDir, sessions.entries))
  }
  return { kind: 'ok', dirs }
}

/** 把项目分组下的目录项转换为会话目录条目,符号链接一并纳入以便由其自身的读取结果判定。 */
function toSessionDirEntries(projectDir: string, entries: Dirent[]): SessionDirEntry[] {
  return entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({ path: join(projectDir, entry.name), name: entry.name }))
}

/** 读取目录项,失败时返回带路径的原因。 */
function readDirectory(dir: string): DirectoryRead {
  try {
    return { kind: 'ok', entries: readdirSync(dir, { withFileTypes: true }) }
  } catch (error) {
    return { kind: 'failed', reason: `cannot list ${dir}: ${describeError(error)}` }
  }
}

/** 统计候选摘要中真实存在的对象数量与字节数,用于预览而不修改任何文件。 */
export function measureAttachmentObjects(dshHome: string, digests: Iterable<string>): AttachmentObjectMeasure {
  const root = attachmentsObjectsDir(dshHome)
  const rootReal = realpathOrNull(root)
  if (rootReal === null) return { count: 0, bytes: 0 }
  let count = 0
  let bytes = 0
  for (const digest of digests) {
    const location = locateObject(root, rootReal, digest)
    if (location.kind !== 'found') continue
    count += 1
    bytes += location.bytes
  }
  return { count, bytes }
}

/**
 * 移除只被待删会话引用的对象,提供备份目录时改为移动,保持备份而非删除的语义。
 * 每个对象都先解析真实路径并确认位于对象存储根之内,越界的目标按失败记录且不会删除。
 */
export function removeAttachmentObjects(
  dshHome: string,
  digests: Iterable<string>,
  options: AttachmentRemovalOptions = {},
): AttachmentRemovalResult {
  const root = attachmentsObjectsDir(dshHome)
  const rootReal = realpathOrNull(root)
  const result: AttachmentRemovalResult = { removed: 0, bytes: 0, failures: [] }
  if (rootReal === null) return result
  for (const digest of digests) {
    const removal = removeLocatedObject(root, rootReal, digest, options)
    if (removal.kind === 'failed') result.failures.push(removal.reason)
    else if (removal.kind === 'removed') {
      result.removed += 1
      result.bytes += removal.bytes
    }
  }
  return result
}

/** 定位一个对象并按其安全校验结论处置,越界的目标按失败返回而不触碰。 */
function removeLocatedObject(
  root: string,
  rootReal: string,
  digest: string,
  options: AttachmentRemovalOptions,
): ObjectRemoval {
  const location = locateObject(root, rootReal, digest)
  if (location.kind === 'absent') return { kind: 'absent' }
  if (location.kind === 'outside') {
    return { kind: 'failed', reason: `${digest}: ${location.resolved} resolves outside ${root}` }
  }
  return removeOneObject(location, digest, options)
}

/** 删除或移动一个已定位的对象,并顺手清理清空后的分片目录。 */
function removeOneObject(
  location: LocatedObject,
  digest: string,
  options: AttachmentRemovalOptions,
): ObjectRemoval {
  try {
    if (options.backupDir === undefined) {
      // 对象以只读权限发布,先放宽权限使行为不依赖平台对只读属性的重试
      chmodSync(location.path, OBJECT_REMOVABLE_MODE)
      rmSync(location.path, { force: true })
    } else {
      moveObjectToBackup(location.path, options.backupDir, digest)
    }
    removeEmptyShard(location.path)
    return { kind: 'removed', bytes: location.bytes }
  } catch (error) {
    return { kind: 'failed', reason: `${digest}: ${describeError(error)}` }
  }
}

/** 把对象移入备份目录,跨卷时退化为复制后删除源文件。 */
function moveObjectToBackup(source: string, backupDir: string, digest: string): void {
  const destination = join(backupDir, ...BACKUP_OBJECT_SEGMENTS, digest.slice(0, SHARD_NAME_LENGTH), digest)
  mkdirSync(dirname(destination), { recursive: true })
  try {
    renameSync(source, destination)
  } catch {
    // 跨卷移动时 rename 会抛出异常,退化为复制文件后删除源文件
    cpSync(source, destination)
    rmSync(source, { force: true })
  }
}

/** 分片目录为空时移除,目录内仍有其他对象或被占用时保持原样。 */
function removeEmptyShard(objectPath: string): void {
  const shardDir = dirname(objectPath)
  try {
    if (readdirSync(shardDir).length > 0) return
    rmdirSync(shardDir)
  } catch {
    // 分片目录被并发写入或占用时保持原样,不影响已经完成的移除
  }
}

/** 解析对象文件的位置与大小,不存在或摘要形态非法时按 absent 处理。 */
function locateObject(root: string, rootReal: string, digest: string): ObjectLocation {
  if (!DIGEST_NAME_PATTERN.test(digest)) return { kind: 'absent' }
  const path = join(root, digest.slice(0, SHARD_NAME_LENGTH), digest)
  let bytes: number
  try {
    bytes = statSync(path).size
  } catch {
    return { kind: 'absent' }
  }
  const resolved = realpathOrNull(path)
  if (resolved === null || !isPathInside(resolved, rootReal)) {
    return { kind: 'outside', resolved: resolved ?? path }
  }
  return { kind: 'found', path, bytes }
}
