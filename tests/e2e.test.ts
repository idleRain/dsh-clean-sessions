import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyClean } from '../src/apply.ts'
import { buildPlan } from '../src/plan.ts'
import {
  baseWorkspaceState,
  canSimulateUnreadableDir,
  makeFixture,
  makeProjectionCacheDoc,
  makeSession,
  makeSessionDir,
  readWorkspaceFile,
  readWorkspaceJson,
  readWorkspaceText,
  writeWorkspaceJson,
  writeWorkspaceState,
} from './helpers.ts'

/** 项目根目录,用于以子进程方式运行源码 CLI。 */
const projectRoot = dirname(import.meta.dirname)

/** 运行源码 CLI 并返回退出码与输出。 */
function runCli(args: string[], fixtureHome: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['src/cli.ts', '--home', fixtureHome, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: '',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 移除夹具中的 sessions 根目录,用于构造根缺失场景。 */
function removeSessionsRoot(dshHome: string): void {
  rmSync(join(dshHome, 'sessions'), { recursive: true, force: true })
}

describe('applyClean', () => {
  test('删除会话并同步配置、清理缓存、保留活跃与非归档会话', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120)
      makeSession(fixture.dshHome, 'proj-b', 'session-recent', 1)
      makeProjectionCacheDoc(fixture.dshHome, 'session-old-1')
      makeProjectionCacheDoc(fixture.dshHome, 'session-ghost')
      const archived = ['session-old-1', 'session-recent', 'session-ghost']
      writeWorkspaceState(
        fixture.dshHome,
        baseWorkspaceState(archived, ['session-old-1', 'session-recent', 'session-live']),
      )
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      assert.equal(outcome.failures.length, 0)
      assert.equal(outcome.cleanedCacheCount, 2)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-b--', 'session-recent')), true)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-live')), true)
      const state = readWorkspaceFile(fixture.dshHome)
      assert.deepEqual(state.global.archivedSessionIds, ['session-recent'])
      assert.deepEqual(state.tables.workspaces['ws-a']!.sessionIds, ['session-recent', 'session-live'])
    } finally {
      fixture.cleanup()
    }
  })

  test('backup 模式把目录移入备份位置并同步配置', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      const archived = ['session-old-1']
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(archived))
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      const backupDir = join(fixture.root, 'backup')
      const outcome = applyClean(fixture.dshHome, plan, { backupDir, updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      assert.equal(existsSync(join(backupDir, '--proj-a--', 'session-old-1')), true)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), false)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('unsafe 会话保留在磁盘与配置中', () => {
    const fixture = makeFixture()
    try {
      const outside = join(fixture.root, 'outside')
      mkdirSync(join(outside, 'session-escaped'), { recursive: true })
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(outside, join(fixture.dshHome, 'sessions', '--link--'), linkType)
      const archived = ['session-escaped']
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(archived))
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 0)
      assert.equal(existsSync(join(outside, 'session-escaped')), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, archived)
    } finally {
      fixture.cleanup()
    }
  })

  test('单项删除失败进入 failures 且不中断整体流程', { skip: !canSimulateUnreadableDir() }, () => {
    const fixture = makeFixture()
    try {
      const dir = makeSession(fixture.dshHome, 'proj-a', 'session-locked', 120)
      // Windows 对只读属性的文件拒绝删除,POSIX 对无写权限的目录拒绝卸载其中的文件
      const isWindows = process.platform === 'win32'
      const protectTarget = isWindows ? join(dir, 'session.v4.jsonl.zstd') : dir
      chmodSync(protectTarget, isWindows ? 0o444 : 0o555)
      try {
        const archived = ['session-locked']
        writeWorkspaceState(fixture.dshHome, baseWorkspaceState(archived))
        const plan = buildPlan(fixture.dshHome, archived, 30, false)
        const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
        assert.equal(outcome.removedCount, 0)
        assert.equal(outcome.failures.length, 1)
        // 删除失败意味着会话可能仍在磁盘,配置不得移除该 id
        assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, archived)
      } finally {
        chmodSync(protectTarget, isWindows ? 0o666 : 0o755)
      }
    } finally {
      fixture.cleanup()
    }
  })

  test('全部删除后二次执行无任何动作,幂等', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      const archived = ['session-old-1']
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(archived))
      const first = buildPlan(fixture.dshHome, archived, 30, false)
      applyClean(fixture.dshHome, first, { updateConfig: true })
      const second = buildPlan(fixture.dshHome, [], 30, false)
      const outcome = applyClean(fixture.dshHome, second, { updateConfig: true })
      assert.equal(outcome.removedCount, 0)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('同步置顶集合时保留存活 id、未知字段与其余字段', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120)
      const state = baseWorkspaceState(['session-old-1'], ['session-old-1', 'session-live'])
      state.global.pinnedSessionIds = ['session-old-1', 'session-live']
      state.global.defaultWorkspaceId = 'ws-a'
      writeWorkspaceJson(fixture.dshHome, { ...state, unknownFutureKey: { a: 1 } })
      const plan = buildPlan(fixture.dshHome, ['session-old-1'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      const written = readWorkspaceJson(fixture.dshHome)
      const global = written['global'] as Record<string, unknown>
      assert.deepEqual(global['archivedSessionIds'], [])
      assert.deepEqual(global['pinnedSessionIds'], ['session-live'])
      assert.equal(global['defaultWorkspaceId'], 'ws-a')
      assert.deepEqual(written['unknownFutureKey'], { a: 1 })
      assert.equal(written['unit'] !== undefined, true)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('CLI 端到端', () => {
  test('干跑模式不修改任何文件', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const before = readWorkspaceFile(fixture.dshHome)
      const result = runCli(['--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /待删除: 1 个/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome), before)
    } finally {
      fixture.cleanup()
    }
  })

  test('--apply --yes 删除会话并同步配置', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), false)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('id 含 ~ 时按 DSH 的目录编码定位并删除', () => {
    const fixture = makeFixture()
    try {
      makeSessionDir(fixture.dshHome, 'proj-a', 'sess~007E1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['sess~1'], ['sess~1']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'sess~007E1')), false)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('非交互环境不带 --yes 时取消执行', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--apply', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已取消/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, ['session-old-1'])
    } finally {
      fixture.cleanup()
    }
  })

  test('--no-config 只删除目录,配置保持不变', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--apply', '--yes', '--no-config', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), false)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, ['session-old-1'])
    } finally {
      fixture.cleanup()
    }
  })

  test('sessions 根缺失时以非零退出码终止且配置字节级不变', () => {
    const fixture = makeFixture()
    try {
      removeSessionsRoot(fixture.dshHome)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-a'], ['session-a', 'session-b']))
      const before = readWorkspaceText(fixture.dshHome)
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.notEqual(result.status, 0)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /会话目录不存在/)
      assert.equal(readWorkspaceText(fixture.dshHome), before)
    } finally {
      fixture.cleanup()
    }
  })

  test('sessions 根是文件时同样硬失败且配置字节级不变', () => {
    const fixture = makeFixture()
    try {
      removeSessionsRoot(fixture.dshHome)
      writeFileSync(join(fixture.dshHome, 'sessions'), 'not a directory', 'utf8')
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-a'], ['session-a', 'session-b']))
      const before = readWorkspaceText(fixture.dshHome)
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /会话目录不可用/)
      assert.equal(readWorkspaceText(fixture.dshHome), before)
    } finally {
      fixture.cleanup()
    }
  })

  test('--allow-missing-sessions 下根缺失时跳过清点且配置不变', () => {
    const fixture = makeFixture()
    try {
      removeSessionsRoot(fixture.dshHome)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-a'], ['session-a', 'session-b']))
      const before = readWorkspaceText(fixture.dshHome)
      const result = runCli(['--apply', '--yes', '--allow-missing-sessions', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stderr, /--allow-missing-sessions/)
      assert.equal(readWorkspaceText(fixture.dshHome), before)
    } finally {
      fixture.cleanup()
    }
  })

  test('--backup 位于 DSH 主目录之内时报前置条件错误', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh', '--backup', join(fixture.dshHome, 'trash')], fixture.dshHome)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /备份目录不能位于/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, ['session-old-1'])
    } finally {
      fixture.cleanup()
    }
  })

  test('空项目分组在删除后被移除', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'solo', 'session-only', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-only']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      const projects = readdirSync(join(fixture.dshHome, 'sessions'))
      assert.deepEqual(projects, [])
    } finally {
      fixture.cleanup()
    }
  })
})
