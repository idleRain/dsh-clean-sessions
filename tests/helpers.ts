/**
 * 测试夹具:在系统临时目录构造假的 DSH 主目录,隔离真实用户数据。
 * 每个用例通过 makeFixture 创建独立目录,结束后调用 cleanup 删除。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
