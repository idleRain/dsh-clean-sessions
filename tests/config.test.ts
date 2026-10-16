import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { preflight, readWorkspaceState, updateWorkspaceConfig, validateWorkspaceState } from '../src/config.ts'
import { ConfigError, PreconditionError } from '../src/errors.ts'
import { buildPlan, collectGoneSessionIds } from '../src/plan.ts'
import {
  baseWorkspaceState,
  makeFixture,
  makeSession,
  readWorkspaceFile,
  readWorkspaceJson,
  writeWorkspaceJson,
  writeWorkspaceState,
} from './helpers.ts'

describe('preflight', () => {
  test('主目录缺失时抛出前置条件错误', () => {
    const fixture = makeFixture()
    try {
      assert.throws(() => preflight(join(fixture.root, 'missing-home')), PreconditionError)
    } finally {
      fixture.cleanup()
    }
  })

  test('配置文件缺失时抛出前置条件错误', () => {
    const fixture = makeFixture()
    try {
      assert.throws(() => preflight(fixture.dshHome), PreconditionError)
    } finally {
      fixture.cleanup()
    }
  })

  test('正常主目录返回会话根目录存在性', () => {
    const fixture = makeFixture()
    try {
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState([]))
      const result = preflight(fixture.dshHome)
      assert.equal(result.sessionsRootExists, true)
      assert.equal(result.sessionsRootStatus, 'usable')
    } finally {
      fixture.cleanup()
    }
  })

  test('会话根目录缺失时抛出前置条件错误,放行时返回缺失状态', () => {
    const fixture = makeFixture()
    try {
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState([]))
      rmSync(join(fixture.dshHome, 'sessions'), { recursive: true, force: true })
      assert.throws(() => preflight(fixture.dshHome), PreconditionError)
      const allowed = preflight(fixture.dshHome, { allowMissingSessions: true })
      assert.equal(allowed.sessionsRootStatus, 'missing')
      assert.equal(allowed.sessionsRootExists, false)
    } finally {
      fixture.cleanup()
    }
  })

  test('会话根目录是文件时抛出前置条件错误而非按缺失处理', () => {
    const fixture = makeFixture()
    try {
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState([]))
      rmSync(join(fixture.dshHome, 'sessions'), { recursive: true, force: true })
      writeFileSync(join(fixture.dshHome, 'sessions'), 'not a directory', 'utf8')
      assert.throws(() => preflight(fixture.dshHome), PreconditionError)
      const allowed = preflight(fixture.dshHome, { allowMissingSessions: true })
      assert.equal(allowed.sessionsRootStatus, 'unavailable')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('validateWorkspaceState', () => {
  test('合法的状态结构校验通过', () => {
    const state = baseWorkspaceState(['session-1'])
    assert.deepEqual(validateWorkspaceState(state).global.archivedSessionIds, ['session-1'])
  })

  test('归档名单不是字符串数组时抛出配置错误', () => {
    assert.throws(() => validateWorkspaceState({ ...baseWorkspaceState([]), global: { initialized: true, workspaceIds: [], archivedSessionIds: 'oops' } }), ConfigError)
  })

  test('workspaceIds 不是字符串数组时抛出配置错误', () => {
    assert.throws(() => validateWorkspaceState({ ...baseWorkspaceState([]), global: { initialized: true, workspaceIds: 3 } }), ConfigError)
  })

  test('归档名单含路径分隔符的 id 时抛出配置错误', () => {
    assert.throws(() => validateWorkspaceState(baseWorkspaceState(['../escape'])), ConfigError)
  })

  test('工作区槽位含反斜杠路径的 id 时抛出配置错误', () => {
    assert.throws(() => validateWorkspaceState(baseWorkspaceState([], ['ws\\escape'])), ConfigError)
  })

  test('置顶集合合法时通过,含不安全 id 或类型不符时抛出配置错误', () => {
    const pinned = baseWorkspaceState([])
    pinned.global.pinnedSessionIds = ['session-1']
    assert.deepEqual(validateWorkspaceState(pinned).global.pinnedSessionIds, ['session-1'])
    const unsafe = baseWorkspaceState([])
    unsafe.global.pinnedSessionIds = ['../escape']
    assert.throws(() => validateWorkspaceState(unsafe), ConfigError)
    const wrongType = baseWorkspaceState([]) as unknown as { global: Record<string, unknown> }
    wrongType.global['pinnedSessionIds'] = 'oops'
    assert.throws(() => validateWorkspaceState(wrongType), ConfigError)
  })

  test('默认工作区 id 类型不符时抛出配置错误', () => {
    const valid = baseWorkspaceState([])
    valid.global.defaultWorkspaceId = 'ws-a'
    assert.equal(validateWorkspaceState(valid).global.defaultWorkspaceId, 'ws-a')
    const wrongType = baseWorkspaceState([]) as unknown as { global: Record<string, unknown> }
    wrongType.global['defaultWorkspaceId'] = 3
    assert.throws(() => validateWorkspaceState(wrongType), ConfigError)
  })
})

describe('readWorkspaceState', () => {
  test('读取合法配置', () => {
    const fixture = makeFixture()
    try {
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-1']))
      const state = readWorkspaceState(fixture.dshHome)
      assert.deepEqual(state.global.archivedSessionIds, ['session-1'])
    } finally {
      fixture.cleanup()
    }
  })

  test('畸形 JSON 抛出配置错误', () => {
    const fixture = makeFixture()
    try {
      writeFileSync(join(fixture.dshHome, 'storages', 'workspace.json'), '{ not json', 'utf8')
      assert.throws(() => readWorkspaceState(fixture.dshHome), ConfigError)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('updateWorkspaceConfig', () => {
  test('按计划给出的已消失 id 移除归档名单与工作区槽位', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-kept', 60)
      const archived = ['session-kept', 'session-gone']
      writeWorkspaceState(
        fixture.dshHome,
        baseWorkspaceState(archived, ['session-kept', 'session-gone', 'session-live']),
      )
      const plan = buildPlan(fixture.dshHome, archived, 30, false)
      const goneIds = collectGoneSessionIds(plan, new Set())
      const result = updateWorkspaceConfig(fixture.dshHome, goneIds)
      assert.equal(result.archivedKept, 1)
      assert.equal(result.slotsRemoved, 1)
      const state = readWorkspaceFile(fixture.dshHome)
      assert.deepEqual(state.global.archivedSessionIds, ['session-kept'])
      assert.deepEqual(state.tables.workspaces['ws-a']!.sessionIds, ['session-kept', 'session-live'])
    } finally {
      fixture.cleanup()
    }
  })

  test('剔除置顶集合中的已消失 id 并保留未知字段', () => {
    const fixture = makeFixture()
    try {
      const state = baseWorkspaceState(['session-gone', 'session-live'], ['session-gone', 'session-live'])
      state.global.pinnedSessionIds = ['session-gone', 'session-live']
      state.global.defaultWorkspaceId = 'ws-a'
      writeWorkspaceJson(fixture.dshHome, { ...state, unknownFutureKey: { a: 1 } })
      const result = updateWorkspaceConfig(fixture.dshHome, new Set(['session-gone']))
      assert.equal(result.archivedKept, 1)
      const written = readWorkspaceJson(fixture.dshHome)
      const global = written['global'] as Record<string, unknown>
      assert.deepEqual(global['archivedSessionIds'], ['session-live'])
      assert.deepEqual(global['pinnedSessionIds'], ['session-live'])
      assert.equal(global['defaultWorkspaceId'], 'ws-a')
      assert.deepEqual(written['unknownFutureKey'], { a: 1 })
      const tables = written['tables'] as { workspaces: Record<string, Record<string, unknown>> }
      assert.deepEqual(tables.workspaces['ws-a']!['sessionIds'], ['session-live'])
      assert.equal(tables.workspaces['ws-a']!['path'], 'E:\\proj-a')
      assert.equal(tables.workspaces['ws-a']!['title'], 'proj-a')
      assert.equal(tables.workspaces['ws-a']!['createdAt'], '2026-01-01T00:00:00.000Z')
    } finally {
      fixture.cleanup()
    }
  })

  test('未提供 gone 集合时配置内容保持不变', () => {
    const fixture = makeFixture()
    try {
      const state = baseWorkspaceState(['session-a'], ['session-a', 'session-b'])
      state.global.pinnedSessionIds = ['session-a']
      writeWorkspaceState(fixture.dshHome, state)
      const result = updateWorkspaceConfig(fixture.dshHome, new Set())
      assert.equal(result.archivedKept, 1)
      assert.equal(result.slotsRemoved, 0)
      const after = readWorkspaceFile(fixture.dshHome)
      assert.deepEqual(after.global.archivedSessionIds, ['session-a'])
      assert.deepEqual(after.global.pinnedSessionIds, ['session-a'])
      assert.deepEqual(after.tables.workspaces['ws-a']!.sessionIds, ['session-a', 'session-b'])
    } finally {
      fixture.cleanup()
    }
  })
})
