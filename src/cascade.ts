/**
 * DSH 会话日志的格式知识与子代理关系图谱:定位最高代规范日志、有界读取头行、构建子代理父子索引与子代理闭包。
 * .jsonl.zstd 是按记录逐帧拼接的容器,头行恒为第 1 帧,读取压缩前缀即可解出头行而不载入整个日志。
 * @module dsh-clean-sessions/cascade
 */

import { closeSync, openSync, readSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { advanceOneFrame } from './zstdFrames.ts'

/** 会话头中与子代理关系相关的字段,扁平头与 meta 嵌套两种形态归一后的结果。 */
export interface SessionHeader {
  id?: string
  parentSession?: string
  origin?: string
}

/** 头行读取的三态结果:missing 表示没有规范日志,unknown 表示有日志但子代理关系无法确认。 */
export type HeaderReadResult =
  | { kind: 'ok'; header: SessionHeader }
  | { kind: 'unknown'; reason: string }
  | { kind: 'missing' }

/** 子代理子会话索引的构建结果,diagnostics 记录无法确认子代理关系的会话。 */
export interface ChildIndexResult {
  index: Map<string, string[]>
  diagnostics: string[]
  scanned: number
}

/** DSH 写入会话头时使用的子代理来源标记,fork 出来的会话不写该字段。 */
export const SUBAGENT_ORIGIN = 'subagent'

/** 规范会话日志文件名:session.jsonl 或 session.vN.jsonl,可带 .zstd 压缩后缀。 */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/** 日志名缺版本段时视为第 0 代,与带版本段的名字一同比较代号。 */
const UNVERSIONED_GENERATION = 0

/** 头行前缀的起始读取字节数,正常头行仅数百字节。 */
const HEADER_PREFIX_INITIAL_BYTES = 4096

/** 头行前缀的读取上限,达到上限仍无法解出则判定日志异常,避免继续放大内存占用。 */
const HEADER_PREFIX_MAX_BYTES = 64 * 1024

/** 换行符码元,用于在明文前缀中定位首行边界。 */
const NEWLINE_CODE = 0x0a

/** 单个日志文件的选择结果,failure 表示目录无法枚举。 */
interface LogSelection {
  candidate?: SessionLogCandidate
  failure?: string
}

/** 候选规范日志的定位信息。 */
interface SessionLogCandidate {
  path: string
  name: string
  generation: number
  compressed: boolean
}

/** 读取前缀的结果,exhausted 表示已读到文件末尾。 */
interface PrefixChunk {
  data: Buffer
  exhausted: boolean
}

/** 只接受非空字符串,其余类型视为未提供。 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断错误是否表示路径确实不存在。 */
function isAbsentError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 把未知错误转成可展示的字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 归一化会话头中的子代理关系字段,同时兼容扁平头与 meta 嵌套两种形态。
 * 头行不是对象时返回 undefined,由调用方按无法确认处理。
 */
export function normalizeSessionHeader(raw: unknown): SessionHeader | undefined {
  if (!isRecord(raw)) return undefined
  const meta: Record<string, unknown> = isRecord(raw['meta']) ? raw['meta'] : {}
  return {
    id: readString(raw['id']),
    parentSession: readString(raw['parentSession']) ?? readString(meta['parentSession']),
    origin: readString(raw['origin']) ?? readString(meta['origin']),
  }
}

/** 读取会话目录内最高代规范日志的头行并归一子代理关系字段。 */
export function readSessionLogHeader(sessionDir: string): HeaderReadResult {
  const selection = pickSessionLogFile(sessionDir)
  if (selection.failure !== undefined) return { kind: 'unknown', reason: selection.failure }
  if (selection.candidate === undefined) return { kind: 'missing' }
  let handle: number
  try {
    handle = openSync(selection.candidate.path, 'r')
  } catch (error) {
    return { kind: 'unknown', reason: `cannot open ${selection.candidate.name}: ${describeError(error)}` }
  }
  try {
    const read = selection.candidate.compressed ? readFirstFrameLine(handle) : readFirstLine(handle)
    return 'failure' in read ? { kind: 'unknown', reason: read.failure } : parseHeaderLine(read.line)
  } finally {
    closeSync(handle)
  }
}

/** 解析头行 JSON 并归一子代理关系字段,首行不是 JSON 对象时返回带原因的结果。 */
function parseHeaderLine(line: string): HeaderReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return { kind: 'unknown', reason: `header line is not valid JSON: ${describeError(error)}` }
  }
  const header = normalizeSessionHeader(parsed)
  if (header === undefined) return { kind: 'unknown', reason: 'header line is not a JSON object' }
  return { kind: 'ok', header }
}

/** 选出会话目录内代号最高的规范日志,同代并存时优先压缩版本。 */
function pickSessionLogFile(sessionDir: string): LogSelection {
  let entries: Dirent[]
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true })
  } catch (error) {
    return isAbsentError(error) ? {} : { failure: `cannot list ${sessionDir}: ${describeError(error)}` }
  }
  let candidate: SessionLogCandidate | undefined
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const found = parseLogCandidate(sessionDir, entry.name)
    if (found === undefined) continue
    if (candidate === undefined || isNewerLog(found, candidate)) candidate = found
  }
  return { candidate }
}

/** 把目录项名解析成候选日志,名字不符合规范或版本段非法时返回 undefined。 */
function parseLogCandidate(sessionDir: string, name: string): SessionLogCandidate | undefined {
  const matched = SESSION_LOG_PATTERN.exec(name)
  if (matched === null) return undefined
  const version = matched[1]
  const generation = version === undefined ? UNVERSIONED_GENERATION : Number.parseInt(version, 10)
  if (!Number.isFinite(generation)) return undefined
  return { path: join(sessionDir, name), name, generation, compressed: matched[2] !== undefined }
}

/**
 * 比较两个候选日志的取舍优先级:代号高者优先。
 * 同代并存意味着压缩设置变更过,压缩版本是 DSH 的默认输出,优先采用。
 */
function isNewerLog(candidate: SessionLogCandidate, current: SessionLogCandidate): boolean {
  if (candidate.generation !== current.generation) return candidate.generation > current.generation
  return candidate.compressed && !current.compressed
}

/** 读取文件起始的定长前缀,返回实际读到的字节与文件是否已读完。 */
function readPrefix(handle: number, size: number): PrefixChunk {
  const buffer = Buffer.alloc(size)
  const bytesRead = readSync(handle, buffer, 0, size, 0)
  return { data: buffer.subarray(0, bytesRead), exhausted: bytesRead < size }
}

/** 取解码结果中的首行,内容不含换行时整段即为首行。 */
function firstLineOf(decoded: Buffer): { line: string } {
  const boundary = decoded.indexOf(NEWLINE_CODE)
  return { line: decoded.toString('utf8', 0, boundary === -1 ? decoded.length : boundary) }
}

/** 读取未压缩日志的首行,前缀不足时翻倍,读到末尾仍无换行则整段视为首行。 */
function readFirstLine(handle: number): { line: string } | { failure: string } {
  for (let size = HEADER_PREFIX_INITIAL_BYTES; size <= HEADER_PREFIX_MAX_BYTES; size *= 2) {
    const chunk = readPrefix(handle, size)
    if (chunk.data.includes(NEWLINE_CODE) || chunk.exhausted) return firstLineOf(chunk.data)
  }
  return { failure: `header line exceeds ${HEADER_PREFIX_MAX_BYTES} bytes` }
}

/**
 * 读取压缩日志第 1 帧的首行,前缀落在帧中途时加长前缀重试。
 * 帧是否完整只由帧结构判定:node:zlib 不保证对截断帧抛错,Node 22 与 24 都会静默返回空明文,
 * 按解压错误码推断"前缀不足"会把只读进半帧的情况当成已完整读出,随后在明文解析处误报。
 */
function readFirstFrameLine(handle: number): { line: string } | { failure: string } {
  for (let size = HEADER_PREFIX_INITIAL_BYTES; size <= HEADER_PREFIX_MAX_BYTES; size *= 2) {
    const chunk = readPrefix(handle, size)
    const advance = advanceOneFrame(chunk.data, 0)
    if (advance.kind === 'invalid') {
      return { failure: `cannot decode first zstd frame: ${advance.reason}` }
    }
    if (advance.kind === 'torn') {
      if (!chunk.exhausted) continue
      return { failure: 'cannot decode first zstd frame: truncated first zstd frame' }
    }
    try {
      return firstLineOf(zstdDecompressSync(chunk.data.subarray(0, advance.end)))
    } catch (error) {
      return { failure: `cannot decode first zstd frame: ${describeError(error)}` }
    }
  }
  return { failure: `first zstd frame exceeds ${HEADER_PREFIX_MAX_BYTES} bytes` }
}

/** 单次遍历全部项目分组,构建"父会话 id 到子代理子会话 id"的索引。 */
export function buildSubagentChildIndex(sessionsRootDir: string): ChildIndexResult {
  const index = new Map<string, string[]>()
  const diagnostics: string[] = []
  let scanned = 0
  for (const projectDir of listSubdirectories(sessionsRootDir, diagnostics)) {
    for (const sessionDir of listSubdirectories(projectDir, diagnostics)) {
      scanned += 1
      const diagnostic = indexSessionDir(sessionDir, index)
      if (diagnostic !== undefined) diagnostics.push(diagnostic)
    }
  }
  return { index, diagnostics, scanned }
}

/** 列出目录下的子目录与目录符号链接,读取失败时记入诊断并返回空列表。 */
function listSubdirectories(dir: string, diagnostics: string[]): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => join(dir, entry.name))
  } catch (error) {
    if (!isAbsentError(error)) diagnostics.push(`cannot list ${dir}: ${describeError(error)}`)
    return []
  }
}

/** 把一个会话目录计入索引,只统计来源为子代理且带父会话 id 的会话。 */
function indexSessionDir(sessionDir: string, index: Map<string, string[]>): string | undefined {
  const result = readSessionLogHeader(sessionDir)
  if (result.kind === 'missing') return undefined
  if (result.kind === 'unknown') return `${sessionDir}: ${result.reason}`
  const { id, parentSession, origin } = result.header
  if (origin !== SUBAGENT_ORIGIN || parentSession === undefined) return undefined
  if (id === undefined) return `${sessionDir}: subagent header lacks a session id`
  appendIndexEntry(index, parentSession, id)
  return undefined
}

/** 把一个子会话 id 追加到父会话名下,重复出现时不重复记录。 */
function appendIndexEntry(index: Map<string, string[]>, parentId: string, childId: string): void {
  const children = index.get(parentId)
  if (children === undefined) {
    index.set(parentId, [childId])
    return
  }
  if (!children.includes(childId)) children.push(childId)
}

/** 反转父子索引,得到"子会话 id 到父会话 id 列表"的映射,用于沿子代理关系回溯。 */
export function invertChildIndex(index: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const parentsByChild = new Map<string, string[]>()
  for (const [parentId, childIds] of index) {
    for (const childId of childIds) appendIndexEntry(parentsByChild, childId, parentId)
  }
  return parentsByChild
}

/**
 * 计算给定会话的全部子代理后代,结果不含根会话自身。
 * 子代理关系可能成环,遍历以已见集合去重,同一 id 只入队一次。
 */
export function collectSubagentDescendants(
  rootIds: Iterable<string>,
  index: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const roots = new Set(rootIds)
  const descendants = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const parentId = pending.pop()
    if (parentId === undefined) continue
    for (const childId of index.get(parentId) ?? []) {
      if (roots.has(childId) || descendants.has(childId)) continue
      descendants.add(childId)
      pending.push(childId)
    }
  }
  return descendants
}

/**
 * 计算给定会话在指定范围内的全部子代理祖先,范围之外的父不再向上回溯。
 * 环同样以已见集合去重,祖先集合不含起点自身。
 */
export function collectSubagentAncestors(
  startIds: Iterable<string>,
  parentsByChild: ReadonlyMap<string, readonly string[]>,
  scope: ReadonlySet<string>,
): Set<string> {
  const ancestors = new Set<string>()
  const pending = [...startIds]
  while (pending.length > 0) {
    const childId = pending.pop()
    if (childId === undefined) continue
    for (const parentId of parentsByChild.get(childId) ?? []) {
      if (!scope.has(parentId) || ancestors.has(parentId)) continue
      ancestors.add(parentId)
      pending.push(parentId)
    }
  }
  return ancestors
}
