import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWriteJson,
  dirSizeBytes,
  findSessionDir,
  formatBytes,
  isPathInside,
  isRecentlyActive,
  latestWriteMinutesAgo,
  removeDirWithRetry,
} from '../src/fsutils.ts'
import { canSimulateUnreadableDir, makeFixture, makeSession } from './helpers.ts'

describe('formatBytes', () => {
  test('边界换算正确', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1023), '1023 B')
    assert.equal(formatBytes(1024), '1.0 KB')
    assert.equal(formatBytes(1024 * 1024), '1.00 MB')
  })
})

describe('isPathInside', () => {
  test('包含与不包含判断', () => {
    assert.equal(isPathInside('C:\\a\\b\\c', 'C:\\a'), true)
    assert.equal(isPathInside('C:\\a\\b', 'C:\\a'), true)
    assert.equal(isPathInside('C:\\ab', 'C:\\a'), false)
    assert.equal(isPathInside('D:\\a', 'C:\\a'), false)
    assert.equal(isPathInside('C:\\a', 'C:\\a'), false)
  })
})

describe('findSessionDir', () => {
  test('能定位会话目录并返回项目分组,未知 id 返回 undefined', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-1', 60)
      const located = findSessionDir(join(fixture.dshHome, 'sessions'), 'session-1')
      assert.ok(located !== undefined)
      assert.equal(located.projectDir, '--proj-a--')
      assert.equal(findSessionDir(join(fixture.dshHome, 'sessions'), 'session-missing'), undefined)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('dirSizeBytes 与活跃度判断', () => {
  test('统计目录大小与最近写入间隔', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSession(fixture.dshHome, 'proj-a', 'session-1', 120, 'x'.repeat(100))
      assert.equal(dirSizeBytes(dir), 100)
      const minutes = latestWriteMinutesAgo(dir)
      assert.ok(minutes !== null && minutes > 100 && minutes < 200)
      assert.equal(isRecentlyActive(dir, 30), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('空目录大小为 0 且不视为最近活跃', () => {
    const fixture = makeFixture()
    try {
      const dir = join(fixture.dshHome, 'sessions', '--proj-a--', 'session-empty')
      mkdirSync(dir, { recursive: true })
      assert.equal(dirSizeBytes(dir), 0)
      assert.equal(latestWriteMinutesAgo(dir), null)
      assert.equal(isRecentlyActive(dir, 30), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('目录不可读时大小未知且活跃判断按可能活跃处理', { skip: !canSimulateUnreadableDir() }, () => {
    const fixture = makeFixture()
    try {
      const dir = makeSession(fixture.dshHome, 'proj-a', 'session-1', 120)
      chmodSync(dir, 0o555)
      try {
        assert.equal(dirSizeBytes(dir), null)
        assert.equal(isRecentlyActive(dir, 30), true)
      } finally {
        chmodSync(dir, 0o755)
      }
    } finally {
      fixture.cleanup()
    }
  })
})

describe('atomicWriteJson', () => {
  test('写入后可读、带换行结尾且不留临时文件', () => {
    const fixture = makeFixture()
    try {
      const target = join(fixture.dshHome, 'storages', 'x.json')
      atomicWriteJson(target, { a: 1 })
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { a: 1 })
      assert.ok(readFileSync(target, 'utf8').endsWith('\n'))
      assert.equal(existsSync(`${target}.tmp`), false)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('removeDirWithRetry', () => {
  test('删除存在的目录且不留下目录', () => {
    const fixture = makeFixture()
    try {
      const dir = makeSession(fixture.dshHome, 'proj-a', 'session-1', 60)
      removeDirWithRetry(dir)
      assert.equal(existsSync(dir), false)
    } finally {
      fixture.cleanup()
    }
  })
})
