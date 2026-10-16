import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyClean } from '../src/apply.ts'
import { buildPlan } from '../src/plan.ts'
import {
  buildSubagentChildIndex,
  collectSubagentAncestors,
  collectSubagentDescendants,
  invertChildIndex,
  readSessionLogHeader,
  type SessionHeader,
} from '../src/lineage.ts'
import { encodeZstdFrames, makeFixture, makeSessionLog, makeZstdSession } from './helpers.ts'

/** 与实现约定的头行前缀上限一致,用于构造首行超长的日志。 */
const OVERSIZED_HEADER_BYTES = 64 * 1024 + 1

/** 断言头行读取成功并返回归一后的血缘字段。 */
function expectHeader(sessionDir: string): SessionHeader {
  const result = readSessionLogHeader(sessionDir)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') throw new Error('expected an ok header result')
  return result.header
}

/** 断言头行无法确认并返回失败原因。 */
function expectUnknown(sessionDir: string): string {
  const result = readSessionLogHeader(sessionDir)
  assert.equal(result.kind, 'unknown')
  if (result.kind !== 'unknown') throw new Error('expected an unknown header result')
  return result.reason
}

/** 把会话目录的日志文本压缩成一帧写入,用于构造较低代的日志文件。 */
function writeZstdLog(sessionDir: string, fileName: string, record: unknown): void {
  writeFileSync(join(sessionDir, fileName), encodeZstdFrames([JSON.stringify(record)]))
}

describe('readSessionLogHeader', () => {
  test('逐帧拼接的 zstd 日志读出第 1 帧头行,后续帧不影响结果', () => {
    const fixture = makeFixture()
    try {
      const dir = makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
        ['{"type":"event","seq":1}'],
      )
      const header = expectHeader(dir)
      assert.equal(header.id, 'session-child')
      assert.equal(header.parentSession, 'session-parent')
      assert.equal(header.origin, 'subagent')
    } finally {
      fixture.cleanup()
    }
  })

  test('未压缩 jsonl 直接读取首行', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(
        fixture.dshHome,
        'proj-a',
        'session-plain',
        'session.v4.jsonl',
        '{"type":"session","id":"session-plain","parentSession":"session-parent"}\n{"type":"event"}\n',
        120,
      )
      const header = expectHeader(dir)
      assert.equal(header.id, 'session-plain')
      assert.equal(header.parentSession, 'session-parent')
      assert.equal(header.origin, undefined)
    } finally {
      fixture.cleanup()
    }
  })

  test('同目录并存多代日志时取代号最高的一代', () => {
    const fixture = makeFixture()
    try {
      const dir = makeZstdSession(fixture.dshHome, 'proj-a', 'session-multi', { id: 'session-multi' }, 120)
      writeZstdLog(dir, 'session.v3.jsonl.zstd', { type: 'session', id: 'session-multi', parentSession: 'session-v3' })
      writeZstdLog(dir, 'session.v4.jsonl.zstd', { type: 'session', id: 'session-multi', parentSession: 'session-v4' })
      assert.equal(expectHeader(dir).parentSession, 'session-v4')
    } finally {
      fixture.cleanup()
    }
  })

  test('无版本段的 session.jsonl.zstd 同样被识别', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(
        fixture.dshHome,
        'proj-a',
        'session-v0',
        'session.jsonl.zstd',
        encodeZstdFrames([JSON.stringify({ type: 'session', id: 'session-v0', origin: 'subagent' })]),
        120,
      )
      const header = expectHeader(dir)
      assert.equal(header.id, 'session-v0')
      assert.equal(header.origin, 'subagent')
    } finally {
      fixture.cleanup()
    }
  })

  test('目录内没有规范日志时返回 missing', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-empty', 'notes.txt', 'nothing', 120)
      assert.equal(readSessionLogHeader(dir).kind, 'missing')
    } finally {
      fixture.cleanup()
    }
  })

  test('目标目录不存在时返回 missing', () => {
    const fixture = makeFixture()
    try {
      const missing = join(fixture.dshHome, 'sessions', '--proj-a--', 'session-absent')
      assert.equal(readSessionLogHeader(missing).kind, 'missing')
    } finally {
      fixture.cleanup()
    }
  })

  test('头行不是 JSON 时返回 unknown 并带原因', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-broken', 'session.v4.jsonl', 'not json\n', 120)
      assert.match(expectUnknown(dir), /not valid JSON/)
    } finally {
      fixture.cleanup()
    }
  })

  test('首行不是对象时返回 unknown 并带原因', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-scalar', 'session.v4.jsonl', '42\n', 120)
      assert.match(expectUnknown(dir), /not a JSON object/)
    } finally {
      fixture.cleanup()
    }
  })

  test('meta 嵌套形态同样取出 parentSession 与 origin', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(
        fixture.dshHome,
        'proj-a',
        'session-nested',
        'session.v4.jsonl',
        '{"type":"session","id":"session-nested","meta":{"parentSession":"session-parent","origin":"subagent"}}\n',
        120,
      )
      const header = expectHeader(dir)
      assert.equal(header.parentSession, 'session-parent')
      assert.equal(header.origin, 'subagent')
    } finally {
      fixture.cleanup()
    }
  })

  test('压缩日志第 1 帧被截断时返回 unknown 而不抛异常', () => {
    const fixture = makeFixture()
    try {
      const frames = encodeZstdFrames([JSON.stringify({ type: 'session', id: 'session-cut', origin: 'subagent' })])
      const truncated = frames.subarray(0, Math.floor(frames.length / 2))
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-cut', 'session.v4.jsonl.zstd', truncated, 120)
      assert.match(expectUnknown(dir), /cannot decode first zstd frame/)
    } finally {
      fixture.cleanup()
    }
  })

  test('非 zstd 内容返回 unknown 而不抛异常', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-fake', 'session.v4.jsonl.zstd', 'data', 120)
      assert.match(expectUnknown(dir), /cannot decode first zstd frame/)
    } finally {
      fixture.cleanup()
    }
  })

  test('明文首行超过前缀上限时返回 unknown', () => {
    const fixture = makeFixture()
    try {
      const oversized = `{"type":"session","padding":"${'x'.repeat(OVERSIZED_HEADER_BYTES)}"}`
      const dir = makeSessionLog(fixture.dshHome, 'proj-a', 'session-long', 'session.v4.jsonl', oversized, 120)
      assert.match(expectUnknown(dir), /exceeds/)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('buildSubagentChildIndex', () => {
  test('只索引 origin 为 subagent 且带父会话的会话,fork 不计入', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child-1',
        { id: 'session-child-1', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      makeZstdSession(
        fixture.dshHome,
        'proj-b',
        'session-child-2',
        { id: 'session-child-2', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      makeZstdSession(fixture.dshHome, 'proj-b', 'session-fork', { id: 'session-fork', parentSession: 'session-parent' }, 120)
      const result = buildSubagentChildIndex(join(fixture.dshHome, 'sessions'))
      assert.deepEqual(result.index.get('session-parent')?.slice().sort(), ['session-child-1', 'session-child-2'])
      assert.equal(result.index.has('session-fork'), false)
      assert.equal(result.scanned, 4)
      assert.deepEqual(result.diagnostics, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('来源为子代理但缺少会话 id 的头行记入诊断', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-noid',
        { parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      const result = buildSubagentChildIndex(join(fixture.dshHome, 'sessions'))
      assert.equal(result.diagnostics.length, 1)
      assert.match(result.diagnostics[0] ?? '', /lacks a session id/)
      assert.equal(result.index.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('日志不可读的会话进入诊断但不中断整体索引', () => {
    const fixture = makeFixture()
    try {
      makeSessionLog(fixture.dshHome, 'proj-a', 'session-bad', 'session.v4.jsonl.zstd', 'data', 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child',
        { id: 'session-child', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      const result = buildSubagentChildIndex(join(fixture.dshHome, 'sessions'))
      assert.equal(result.scanned, 2)
      assert.equal(result.diagnostics.length, 1)
      assert.match(result.diagnostics[0] ?? '', /cannot decode first zstd frame/)
      assert.deepEqual(result.index.get('session-parent'), ['session-child'])
    } finally {
      fixture.cleanup()
    }
  })
})

describe('collectSubagentDescendants', () => {
  test('传递闭包覆盖多级后代', () => {
    const index = new Map([['a', ['b']], ['b', ['c', 'd']], ['c', ['e']]])
    assert.deepEqual([...collectSubagentDescendants(['a'], index)].sort(), ['b', 'c', 'd', 'e'])
  })

  test('a 与 b 互指时不死循环,根会话不计入后代', () => {
    const index = new Map([['a', ['b']], ['b', ['a']]])
    assert.deepEqual([...collectSubagentDescendants(['a'], index)], ['b'])
  })

  test('多个根会话共享后代时只收集一次', () => {
    const index = new Map([['a', ['c']], ['b', ['c']], ['c', ['d']]])
    assert.deepEqual([...collectSubagentDescendants(['a', 'b'], index)].sort(), ['c', 'd'])
  })
})

describe('血缘回溯', () => {
  test('反转索引后可沿直接父回溯祖先,范围之外的父不再向上', () => {
    const index = new Map([['a', ['b']], ['b', ['c']]])
    const parentsByChild = invertChildIndex(index)
    assert.deepEqual(parentsByChild.get('c'), ['b'])
    assert.deepEqual([...collectSubagentAncestors(['c'], parentsByChild, new Set(['a', 'b', 'c']))], ['b', 'a'])
    assert.deepEqual([...collectSubagentAncestors(['c'], parentsByChild, new Set(['b', 'c']))], ['b'])
  })
})

describe('buildPlan 血缘级联', () => {
  test('子代理后代随父会话级联删除,fork 及其派生后代保留', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-child-1',
        { id: 'session-child-1', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      makeZstdSession(
        fixture.dshHome,
        'proj-b',
        'session-child-2',
        { id: 'session-child-2', parentSession: 'session-parent', origin: 'subagent' },
        120,
      )
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-fork', { id: 'session-fork', parentSession: 'session-parent' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-fork-child',
        { id: 'session-fork-child', parentSession: 'session-fork', origin: 'subagent' },
        120,
      )
      const plan = buildPlan(fixture.dshHome, ['session-parent'], 30, false)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-parent'])
      assert.deepEqual(plan.cascade.map(item => item.id).sort(), ['session-child-1', 'session-child-2'])
      assert.equal(plan.blocked.length, 0)
      assert.equal(plan.cascade.find(item => item.id === 'session-child-1')?.cascadeSource, 'session-parent')
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: false })
      assert.equal(outcome.removedCount, 3)
      assert.equal(outcome.cascadeRemovedCount, 2)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-child-1')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-b--', 'session-child-2')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-fork')), true)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-fork-child')), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('子代理的子代理同样被深度级联', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-root', { id: 'session-root' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-depth-1',
        { id: 'session-depth-1', parentSession: 'session-root', origin: 'subagent' },
        120,
      )
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-depth-2',
        { id: 'session-depth-2', parentSession: 'session-depth-1', origin: 'subagent' },
        120,
      )
      const plan = buildPlan(fixture.dshHome, ['session-root'], 30, false)
      assert.deepEqual(plan.cascade.map(item => item.id).sort(), ['session-depth-1', 'session-depth-2'])
      applyClean(fixture.dshHome, plan, { updateConfig: false })
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-depth-1')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-depth-2')), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('keepChildren 为真时不做级联,后代全部保留', () => {
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
      const plan = buildPlan(fixture.dshHome, ['session-parent'], 30, false, true)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-parent'])
      assert.equal(plan.cascade.length, 0)
      applyClean(fixture.dshHome, plan, { updateConfig: false })
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-parent')), false)
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-child')), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('后代最近有写入时祖先进入 blocked,加 includeRecent 后可删', () => {
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
      const plan = buildPlan(fixture.dshHome, ['session-parent'], 30, false)
      assert.deepEqual(plan.toDelete, [])
      assert.deepEqual(plan.blocked.map(item => item.id), ['session-parent'])
      assert.equal(plan.blocked[0]?.blockedReason?.key, 'blockedByRecentDescendant')
      assert.deepEqual(plan.blocked[0]?.blockedReason?.params, { childId: 'session-child' })
      assert.deepEqual(plan.cascade, [])
      const included = buildPlan(fixture.dshHome, ['session-parent'], 30, true)
      assert.deepEqual(included.toDelete.map(item => item.id), ['session-parent'])
      assert.deepEqual(included.cascade.map(item => item.id), ['session-child'])
      assert.deepEqual(included.blocked, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('后代是多级链中层最近有写入时,整个祖先链被阻止', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-root', { id: 'session-root' }, 120)
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-mid',
        { id: 'session-mid', parentSession: 'session-root', origin: 'subagent' },
        120,
      )
      makeZstdSession(
        fixture.dshHome,
        'proj-b',
        'session-leaf',
        { id: 'session-leaf', parentSession: 'session-mid', origin: 'subagent' },
        1,
      )
      const plan = buildPlan(fixture.dshHome, ['session-root'], 30, false)
      assert.deepEqual(plan.toDelete, [])
      assert.deepEqual(plan.blocked.map(item => item.id), ['session-root'])
      assert.deepEqual(plan.cascade, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('后代逃逸出 sessions 根目录时祖先被阻止,逃逸目标保持不动', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      const outsideChild = join(fixture.root, 'outside', 'session-escaped-child')
      mkdirSync(outsideChild, { recursive: true })
      writeFileSync(
        join(outsideChild, 'session.v4.jsonl.zstd'),
        encodeZstdFrames([
          JSON.stringify({ type: 'session', id: 'session-escaped-child', parentSession: 'session-parent', origin: 'subagent' }),
        ]),
      )
      // Windows 用 junction,其他平台用目录符号链接,均不需要管理员权限
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(join(fixture.root, 'outside'), join(fixture.dshHome, 'sessions', '--link--'), linkType)
      const plan = buildPlan(fixture.dshHome, ['session-parent'], 30, false)
      assert.deepEqual(plan.toDelete, [])
      assert.deepEqual(plan.blocked.map(item => item.id), ['session-parent'])
      assert.equal(plan.blocked[0]?.blockedReason?.key, 'blockedByUnsafeDescendant')
      assert.deepEqual(plan.blocked[0]?.blockedReason?.params, { childId: 'session-escaped-child' })
      // 逃逸不是活跃度问题,includeRecent 不会放行
      const included = buildPlan(fixture.dshHome, ['session-parent'], 30, true)
      assert.deepEqual(included.toDelete, [])
      assert.deepEqual(included.blocked.map(item => item.id), ['session-parent'])
      applyClean(fixture.dshHome, plan, { updateConfig: false })
      assert.equal(existsSync(join(fixture.dshHome, 'sessions', '--proj-a--', 'session-parent')), true)
      assert.equal(existsSync(outsideChild), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('血缘成环时计划构建不死循环', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(
        fixture.dshHome,
        'proj-a',
        'session-a',
        { id: 'session-a', parentSession: 'session-b', origin: 'subagent' },
        120,
      )
      makeZstdSession(
        fixture.dshHome,
        'proj-b',
        'session-b',
        { id: 'session-b', parentSession: 'session-a', origin: 'subagent' },
        120,
      )
      const index = buildSubagentChildIndex(join(fixture.dshHome, 'sessions')).index
      assert.deepEqual([...collectSubagentDescendants(['session-a'], index)], ['session-b'])
      const plan = buildPlan(fixture.dshHome, ['session-a'], 30, false)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-a'])
      assert.deepEqual(plan.cascade.map(item => item.id), ['session-b'])
    } finally {
      fixture.cleanup()
    }
  })

  test('归档名单内的后代不重复纳入级联,仍按名单删除', () => {
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
      const plan = buildPlan(fixture.dshHome, ['session-parent', 'session-child'], 30, false)
      assert.deepEqual(plan.toDelete.map(item => item.id).sort(), ['session-child', 'session-parent'])
      assert.deepEqual(plan.cascade, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('归档名单内但最近有写入的后代同样阻止祖先', () => {
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
      const plan = buildPlan(fixture.dshHome, ['session-parent', 'session-child'], 30, false)
      assert.deepEqual(plan.toDelete, [])
      assert.deepEqual(plan.blocked.map(item => item.id), ['session-parent'])
      assert.deepEqual(plan.recentExcluded.map(item => item.id), ['session-child'])
    } finally {
      fixture.cleanup()
    }
  })

  test('日志不可读的会话只产生诊断,不影响待删会话的归类', () => {
    const fixture = makeFixture()
    try {
      makeZstdSession(fixture.dshHome, 'proj-a', 'session-parent', { id: 'session-parent' }, 120)
      makeSessionLog(fixture.dshHome, 'proj-b', 'session-unreadable', 'session.v4.jsonl.zstd', 'data', 120)
      const plan = buildPlan(fixture.dshHome, ['session-parent'], 30, false)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-parent'])
      assert.equal(plan.lineageWarnings.length, 1)
      assert.match(plan.lineageWarnings[0] ?? '', /session-unreadable/)
    } finally {
      fixture.cleanup()
    }
  })
})
