import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWriteJson,
  dirSizeBytes,
  findSessionDir,
  formatBytes,
  inspectSessionsRoot,
  isPathInside,
  isRecentlyActive,
  latestWriteMinutesAgo,
  removeDirWithRetry,
} from '../src/fsutils.ts'
import { encodeSegment } from '../src/paths.ts'
import { PreconditionError } from '../src/errors.ts'
import { canSimulateUnreadableDir, makeFixture, makeSession, makeSessionDir } from './helpers.ts'

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
    // 用当前工作目录构造平台正确的绝对路径,Windows 风格路径在 POSIX 上不是合法分隔符
    const base = process.cwd()
    assert.equal(isPathInside(join(base, 'a', 'b', 'c'), join(base, 'a')), true)
    assert.equal(isPathInside(join(base, 'a', 'b'), join(base, 'a')), true)
    assert.equal(isPathInside(join(base, 'ab'), join(base, 'a')), false)
    assert.equal(isPathInside(join(base, 'a'), join(base, 'a')), false)
    // 跨盘符属于 Windows 特有语义,其余平台无法构造等价用例
    if (process.platform === 'win32') {
      assert.equal(isPathInside('D:\\a', 'C:\\a'), false)
    }
  })
})

describe('encodeSegment', () => {
  test('逐 UTF-16 码元复刻 DSH 的转义规则', () => {
    assert.equal(encodeSegment('session-1'), 'session-1')
    assert.equal(encodeSegment('~'), '~007E')
    assert.equal(encodeSegment('.'), '~002E')
    assert.equal(encodeSegment('..'), '~002E~002E')
    assert.equal(encodeSegment('a b'), 'a~0020b')
    assert.equal(encodeSegment('会话'), '~4F1A~8BDD')
    assert.equal(encodeSegment('😀'), '~D83D~DE00')
    assert.equal(encodeSegment('\uD800'), '~D800')
  })

  test('空字符串抛出异常', () => {
    assert.throws(() => encodeSegment(''), /empty path segment/)
  })

  test('路径分隔符与冒号都被转义,结果始终是单一安全路径段', () => {
    const encoded = encodeSegment('../..\\evil:name')
    assert.equal(encoded.includes('/'), false)
    assert.equal(encoded.includes('\\'), false)
    assert.equal(encoded.includes(':'), false)
    assert.equal(encodeSegment('.hidden').startsWith('.'), true)
  })
})

describe('inspectSessionsRoot', () => {
  test('区分可用、缺失与不可用三种状态', () => {
    const fixture = makeFixture()
    try {
      const root = join(fixture.dshHome, 'sessions')
      assert.equal(inspectSessionsRoot(root).status, 'usable')
      rmSync(root, { recursive: true, force: true })
      assert.equal(inspectSessionsRoot(root).status, 'missing')
      writeFileSync(root, 'not a directory', 'utf8')
      assert.equal(inspectSessionsRoot(root).status, 'unavailable')
    } finally {
      fixture.cleanup()
    }
  })

  test('根缺失或不可用时查找抛出对应的前置条件错误', () => {
    const fixture = makeFixture()
    try {
      const root = join(fixture.dshHome, 'sessions')
      rmSync(root, { recursive: true, force: true })
      assert.throws(
        () => findSessionDir(root, 'session-1'),
        (error: unknown) => error instanceof PreconditionError && error.key === 'sessionsRootMissing',
      )
      writeFileSync(root, 'not a directory', 'utf8')
      assert.throws(
        () => findSessionDir(root, 'session-1'),
        (error: unknown) => error instanceof PreconditionError && error.key === 'sessionsRootUnavailable',
      )
    } finally {
      fixture.cleanup()
    }
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

  test('含 ~ 的 id 按 DSH 的目录编码定位', () => {
    const fixture = makeFixture()
    try {
      makeSessionDir(fixture.dshHome, 'proj-a', 'sess~007E1', 60)
      const located = findSessionDir(join(fixture.dshHome, 'sessions'), 'sess~1')
      assert.ok(located !== undefined)
      assert.equal(located.projectDir, '--proj-a--')
    } finally {
      fixture.cleanup()
    }
  })

  test('候选路径的父级是文件时判定为不可核实并终止', { skip: process.platform === 'win32' }, () => {
    // Windows 把"路径中间段是文件"的遍历错误统一报告为 ENOENT,无法构造 ENOTDIR
    const fixture = makeFixture()
    try {
      const target = join(fixture.root, 'plain-file')
      writeFileSync(target, 'x', 'utf8')
      symlinkSync(target, join(fixture.dshHome, 'sessions', '--proj-file--'), 'file')
      assert.throws(
        () => findSessionDir(join(fixture.dshHome, 'sessions'), 'session-1'),
        (error: unknown) => error instanceof PreconditionError && error.key === 'sessionDirUnverifiable',
      )
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
      // 枚举目录需要读权限位,须全部移除才能让 readdirSync 抛出权限错误
      chmodSync(dir, 0o000)
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
