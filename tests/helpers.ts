/**
 * 测试夹具:在系统临时目录构造假的 DSH 主目录,隔离真实用户数据。
 * 每个用例通过 makeFixture 创建独立目录,结束后调用 cleanup 删除。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { WorkspaceState } from '../src/types.ts'

/** 一次测试使用的隔离环境,包含可写的主目录路径与清理回调。 */
export interface Fixture {
  root: string
  dshHome: string
  cleanup: () => void
}

/** 创建隔离的假 DSH 主目录,预先建好 sessions 与 storages 目录。 */
export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-sessions-'))
  const dshHome = join(root, 'home')
  mkdirSync(join(dshHome, 'sessions'), { recursive: true })
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  return { root, dshHome, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 写入 workspace.json,内容序列化为带换行结尾的格式化 JSON。 */
export function writeWorkspaceState(dshHome: string, state: WorkspaceState): void {
  writeWorkspaceJson(dshHome, state)
}

/** 写入任意 workspace.json 内容,用于构造含未知字段的夹具。 */
export function writeWorkspaceJson(dshHome: string, value: unknown): void {
  writeFileSync(join(dshHome, 'storages', 'workspace.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 读取 workspace.json 的当前内容。 */
export function readWorkspaceFile(dshHome: string): WorkspaceState {
  return JSON.parse(readWorkspaceText(dshHome)) as WorkspaceState
}

/** 读取 workspace.json 的原始 JSON,用于断言未知字段是否保真。 */
export function readWorkspaceJson(dshHome: string): Record<string, unknown> {
  return JSON.parse(readWorkspaceText(dshHome)) as Record<string, unknown>
}

/** 读取 workspace.json 的原始文本,用于字节级比较。 */
export function readWorkspaceText(dshHome: string): string {
  return readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8')
}

/**
 * 在指定项目分组下创建会话目录与 V4 日志文件,并把日志修改时间回拨到指定分钟数之前。
 * 目录名与 id 解耦,以便构造 DSH 会编码目录名的场景。
 */
export function makeSessionDir(dshHome: string, project: string, dirName: string, ageMinutes: number, payload = 'data'): string {
  const dir = join(dshHome, 'sessions', `--${project}--`, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, payload, 'utf8')
  const past = new Date(Date.now() - ageMinutes * 60_000)
  utimesSync(file, past, past)
  return dir
}

/** 按会话 id 直接命名目录创建会话,适用于 id 本身就是合法目录名的场景。 */
export function makeSession(dshHome: string, project: string, id: string, ageMinutes: number, payload = 'data'): string {
  return makeSessionDir(dshHome, project, id, ageMinutes, payload)
}

/** 会话头行的最小构造参数,与 DSH 写入日志的首行字段一致,id 缺省用于构造异常头行。 */
export interface SessionHeaderFixture {
  id?: string
  parentSession?: string
  origin?: string
}

/** 把若干条记录逐条压缩成 zstd 帧并拼接,复刻 DSH 一条记录一帧的容器格式。 */
export function encodeZstdFrames(records: readonly string[]): Buffer {
  return Buffer.concat(records.map(record => zstdCompressSync(Buffer.from(record, 'utf8'))))
}

/**
 * 在会话目录下写入指定文件名的日志,并把修改时间回拨到指定分钟数之前。
 * 文件名由调用方给出,以便构造多代并存、明文日志与日志缺失等场景。
 */
export function makeSessionLog(
  dshHome: string,
  project: string,
  dirName: string,
  fileName: string,
  content: string | Buffer,
  ageMinutes: number,
): string {
  const dir = join(dshHome, 'sessions', `--${project}--`, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(file, content)
  const past = new Date(Date.now() - ageMinutes * 60_000)
  utimesSync(file, past, past)
  return dir
}

/**
 * 用真实 zstd 逐帧拼接写出会话日志,头行取最高代命名 session.v4.jsonl.zstd。
 * 追加记录会成为后续帧,用于验证只解第 1 帧的读取方式不受后续记录影响。
 */
export function makeZstdSession(
  dshHome: string,
  project: string,
  dirName: string,
  header: SessionHeaderFixture,
  ageMinutes: number,
  extraRecords: readonly string[] = [],
): string {
  const records = [JSON.stringify({ type: 'session', ...header }), ...extraRecords]
  return makeSessionLog(dshHome, project, dirName, 'session.v4.jsonl.zstd', encodeZstdFrames(records), ageMinutes)
}

/** 在投影缓存 per-record 目录下创建指定会话的文档。 */
export function makeProjectionCacheDoc(dshHome: string, id: string): void {
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), '{}', 'utf8')
}

/** 构造最小可用的 workspace 状态,归档名单与工作区槽位默认保持一致。 */
export function baseWorkspaceState(archivedIds: string[], sessionIds?: string[]): WorkspaceState {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [...archivedIds] },
    tables: {
      workspaces: {
        'ws-a': {
          path: 'E:\\proj-a',
          title: 'proj-a',
          sessionIds: [...(sessionIds ?? archivedIds)],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
}

/** 判断当前环境能否用权限位模拟不可读目录,Windows 与 root 环境均无法模拟。 */
export function canSimulateUnreadableDir(): boolean {
  if (process.platform === 'win32') return false
  return !(typeof process.getuid === 'function' && process.getuid() === 0)
}

/** 构造一个由单个十六进制字符重复而成的 64 位摘要,便于在测试中区分对象。 */
export function makeDigest(hexChar: string): string {
  return hexChar.repeat(64)
}

/** 返回内容寻址对象在附件存储中的路径。 */
export function attachmentObjectPath(dshHome: string, digest: string): string {
  return join(dshHome, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
}

/** 在附件对象存储下写入一个对象文件,返回其路径。 */
export function makeAttachmentObject(dshHome: string, digest: string, sizeBytes = 16): string {
  const file = attachmentObjectPath(dshHome, digest)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(sizeBytes, 7))
  return file
}

/** 在附件暂存目录下写入一个条目,用于模拟正在进行的写入。 */
export function makeAttachmentTmpEntry(dshHome: string, name = 'pending'): string {
  const file = join(dshHome, 'attachments', 'v1', 'tmp', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'partial', 'utf8')
  return file
}

/**
 * 写入一份逐帧压缩的会话日志,记录的文本里以字面形式携带给定摘要。
 * 目录名同时作为会话 id 写入头记录,便于按目录名归属引用。
 */
export function makeReferenceLog(
  dshHome: string,
  project: string,
  dirName: string,
  fileName: string,
  digests: readonly string[],
  ageMinutes = 120,
): string {
  const records = [
    JSON.stringify({ type: 'session', id: dirName }),
    ...digests.map(digest => JSON.stringify({ type: 'user/message', attachment: `sha256:${digest}` })),
  ]
  return makeSessionLog(dshHome, project, dirName, fileName, encodeZstdFrames(records), ageMinutes)
}

/** 写入一份未压缩的会话日志,每行一条携带摘要字面引用的记录。 */
export function makePlainReferenceLog(
  dshHome: string,
  project: string,
  dirName: string,
  digests: readonly string[],
  ageMinutes = 120,
): string {
  const lines = [
    JSON.stringify({ type: 'session', id: dirName }),
    ...digests.map(digest => JSON.stringify({ type: 'tool/result', attachment: `sha256:${digest}` })),
  ]
  return makeSessionLog(dshHome, project, dirName, 'session.v4.jsonl', `${lines.join('\n')}\n`, ageMinutes)
}
