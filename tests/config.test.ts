import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { preflight, readWorkspaceState, updateWorkspaceConfig, validateWorkspaceState } from '../src/config.ts'
import { ConfigError, PreconditionError } from '../src/errors.ts'
import { baseWorkspaceState, makeFixture, makeSession, readWorkspaceFile, writeWorkspaceState } from './helpers.ts'

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
  test('移除磁盘上已不存在的会话 id 与工作区槽位', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-kept', 60)
      writeWorkspaceState(
        fixture.dshHome,
        baseWorkspaceState(['session-kept', 'session-gone'], ['session-kept', 'session-gone', 'session-live']),
      )
      const result = updateWorkspaceConfig(fixture.dshHome)
      assert.equal(result.archivedKept, 1)
      assert.equal(result.slotsRemoved, 1)
      const state = readWorkspaceFile(fixture.dshHome)
      assert.deepEqual(state.global.archivedSessionIds, ['session-kept'])
      assert.deepEqual(state.tables.workspaces['ws-a']!.sessionIds, ['session-kept', 'session-live'])
    } finally {
      fixture.cleanup()
    }
  })
})
