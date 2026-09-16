import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { buildPlan, collectGoneSessionIds } from '../src/plan.ts'
import { makeFixture, makeSession } from './helpers.ts'

describe('buildPlan', () => {
  test('旧会话进入待删除,最近写入被排除,缺失归为幽灵', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old', 120)
      makeSession(fixture.dshHome, 'proj-b', 'session-recent', 1)
      const archived = ['session-old', 'session-recent', 'session-ghost']
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-old'])
      assert.deepEqual(plan.recentExcluded.map(item => item.id), ['session-recent'])
      assert.deepEqual(plan.ghosts.map(item => item.id), ['session-ghost'])
      assert.equal(plan.unsafe.length, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('includeRecent 把最近写入纳入待删除', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old', 120)
      makeSession(fixture.dshHome, 'proj-b', 'session-recent', 1)
      const archived = ['session-old', 'session-recent']
      const plan = buildPlan(fixture.dshHome, archived, 30, true)
      assert.deepEqual(plan.toDelete.map(item => item.id).sort(), ['session-old', 'session-recent'])
      assert.equal(plan.recentExcluded.length, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('minAge 为 0 时不做活跃排除', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-b', 'session-recent', 1)
      const plan = buildPlan(fixture.dshHome, ['session-recent'], 0, false)
      assert.deepEqual(plan.toDelete.map(item => item.id), ['session-recent'])
      assert.equal(plan.recentExcluded.length, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('符号链接逃逸的会话进入 unsafe 且不会删除', () => {
    const fixture = makeFixture()
    try {
      const outside = join(fixture.root, 'outside')
      mkdirSync(join(outside, 'session-escaped'), { recursive: true })
      // Windows 用 junction,其他平台用目录符号链接,均不需要管理员权限
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(outside, join(fixture.dshHome, 'sessions', '--link--'), linkType)
      const plan = buildPlan(fixture.dshHome, ['session-escaped'], 30, false)
      assert.deepEqual(plan.unsafe.map(item => item.id), ['session-escaped'])
      assert.equal(plan.toDelete.length, 0)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('collectGoneSessionIds', () => {
  test('只返回磁盘上不存在的 id', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-a', 60)
      const gone = collectGoneSessionIds(fixture.dshHome, ['session-a', 'session-b'])
      assert.deepEqual([...gone], ['session-b'])
    } finally {
      fixture.cleanup()
    }
  })
})
