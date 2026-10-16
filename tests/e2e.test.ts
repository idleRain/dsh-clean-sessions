import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyClean } from '../src/apply.ts'
import { buildPlan } from '../src/plan.ts'
import {
  attachmentObjectPath,
  baseWorkspaceState,
  canSimulateUnreadableDir,
  makeAttachmentObject,
  makeDigest,
  makeFixture,
  makeProjectionCacheDoc,
  makeReferenceLog,
  makeSession,
  makeSessionDir,
  makeZstdSession,
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

  test('投影缓存文档删除失败时记入失败项且仍完成配置同步', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      makeProjectionCacheDoc(fixture.dshHome, 'session-old-1')
      // 用同名目录占位,让删除抛出非瞬时错误,以便在真实文件系统上模拟单项失败
      mkdirSync(
        join(fixture.dshHome, 'storages', 'session_projcache', 'sessions', 'session-ghost.json'),
        { recursive: true },
      )
      const archived = ['session-old-1', 'session-ghost']
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(archived))
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.cleanedCacheCount, 1)
      assert.equal(outcome.failures.length, 1)
      assert.match(outcome.failures[0] ?? '', /session-ghost/)
      // 关键:单项缓存失败不得阻止配置同步
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
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

  test('预览分别列出级联后代与被阻止的祖先', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-parent'], ['session-parent']))
      const result = runCli(['--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /血缘级联纳入删除: 1 个/)
      assert.match(result.stdout, /session-child .* 来源: session-parent/)
      assert.equal(result.stdout.includes('因血缘后代无法处理'), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('--keep-children 只删除归档名单内的会话,子代理后代保留', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-parent'], ['session-parent']))
      const result = runCli(['--apply', '--yes', '--keep-children', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已按 --keep-children 跳过血缘级联/)
      assert.match(result.stdout, /其中由血缘级联移除: 0 个/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-parent')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-child')), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('级联删除的子代理 id 同步从工作区槽位、归档名单与置顶集合清理', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120)
      const state = baseWorkspaceState(['session-parent'], ['session-parent', 'session-child', 'session-live'])
      state.global.pinnedSessionIds = ['session-child', 'session-live']
      writeWorkspaceJson(fixture.dshHome, state)
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /其中由血缘级联移除: 1 个/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-child')), false)
      const written = readWorkspaceFile(fixture.dshHome)
      assert.deepEqual(written.global.archivedSessionIds, [])
      assert.deepEqual(written.global.pinnedSessionIds, ['session-live'])
      assert.deepEqual(written.tables.workspaces['ws-a']!.sessionIds, ['session-live'])
    } finally {
      fixture.cleanup()
    }
  })

  test('级联删除后二次执行无任何动作,幂等', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-parent'], ['session-parent']))
      const first = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(first.status, 0)
      assert.match(first.stdout, /已移除会话目录: 2 个/)
      assert.match(first.stdout, /其中由血缘级联移除: 1 个/)
      const second = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(second.status, 0)
      assert.match(second.stdout, /没有已归档的会话/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-child')), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('后代最近有写入时祖先被阻止,预览给出可操作原因且不删除', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        1,
      )
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-parent'], ['session-parent']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /因血缘后代无法处理,以下 1 个归档会话本次保留/)
      assert.match(result.stdout, /原因: 后代 session-child 最近仍有写入/)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-parent')), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, ['session-parent'])
    } finally {
      fixture.cleanup()
    }
  })

  test('血缘诊断列出日志不可读的会话数', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old-1', 120)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /血缘诊断: 1 条/)
    } finally {
      fixture.cleanup()
    }
  })

  test('预览显示预计回收的附件对象数与字节数', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('a')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old-1', 'session.v4.jsonl.zstd', [digest])
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-live', 'session.v4.jsonl.zstd', [])
      makeAttachmentObject(fixture.dshHome, digest, 2048)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1'], ['session-old-1', 'session-live']))
      const result = runCli(['--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /附件对象预计回收: 1 个, 2\.0 KB/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, digest)), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('--apply 回收只被待删会话引用的附件对象并汇总', () => {
    const fixture = makeFixture()
    try {
      const deletedOnly = makeDigest('b')
      const shared = makeDigest('c')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old-1', 'session.v4.jsonl.zstd', [deletedOnly, shared])
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-live', 'session.v4.jsonl.zstd', [shared])
      makeAttachmentObject(fixture.dshHome, deletedOnly, 16)
      makeAttachmentObject(fixture.dshHome, shared, 16)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1'], ['session-old-1', 'session-live']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已回收附件对象: 1 个, 16 B/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, deletedOnly)), false)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, shared)), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('--keep-attachments 保留附件对象且会话目录照常删除', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('d')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old-1', 'session.v4.jsonl.zstd', [digest])
      makeAttachmentObject(fixture.dshHome, digest, 16)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const result = runCli(['--apply', '--yes', '--keep-attachments', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已按 --keep-attachments 跳过附件回收/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, digest)), true)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-old-1')), false)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('--backup 把附件对象移入备份目录而非删除', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('e')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old-1', 'session.v4.jsonl.zstd', [digest])
      makeAttachmentObject(fixture.dshHome, digest, 16)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1']))
      const backupDir = join(fixture.root, 'backup')
      const result = runCli(['--apply', '--yes', '--lang', 'zh', '--backup', backupDir], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已回收附件对象: 1 个/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, digest)), false)
      assert.equal(existsSync(join(backupDir, 'attachments', 'objects', 'ee', digest)), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('存活会话日志不可读时跳过回收,会话删除与配置同步不受影响', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('f')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old-1', 'session.v4.jsonl.zstd', [digest])
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120, 'not a zstd container')
      makeAttachmentObject(fixture.dshHome, digest, 16)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old-1'], ['session-old-1', 'session-live']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stderr, /已跳过附件回收/)
      assert.match(result.stdout, /已移除会话目录: 1 个/)
      assert.match(result.stdout, /配置同步完成/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, digest)), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).tables.workspaces['ws-a']!.sessionIds, ['session-live'])
    } finally {
      fixture.cleanup()
    }
  })

  test('血缘级联删除的后代引用对象同样被回收', () => {
    const fixture = makeFixture()
    try {
      const parentOnly = makeDigest('1')
      const childOnly = makeDigest('2')
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120, [
        JSON.stringify({ type: 'user/message', attachment: `sha256:${parentOnly}` }),
      ])
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
        [JSON.stringify({ type: 'user/message', attachment: `sha256:${childOnly}` })],
      )
      makeAttachmentObject(fixture.dshHome, parentOnly, 16)
      makeAttachmentObject(fixture.dshHome, childOnly, 16)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-parent'], ['session-parent']))
      const result = runCli(['--apply', '--yes', '--lang', 'zh'], fixture.dshHome)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /已回收附件对象: 2 个, 32 B/)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, parentOnly)), false)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, childOnly)), false)
    } finally {
      fixture.cleanup()
    }
  })
})
