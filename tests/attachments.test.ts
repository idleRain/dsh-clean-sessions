import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import {
  collectLogDigests,
  collectReclaimableObjects,
  measureAttachmentObjects,
  readFrameSpans,
  removeAttachmentObjects,
} from '../src/attachments.ts'
import { applyClean } from '../src/apply.ts'
import { buildPlan } from '../src/plan.ts'
import {
  type Fixture,
  attachmentObjectPath,
  baseWorkspaceState,
  canSimulateUnreadableDir,
  encodeZstdFrames,
  makeAttachmentObject,
  makeAttachmentTmpEntry,
  makeDigest,
  makeFixture,
  makePlainReferenceLog,
  makeReferenceLog,
  makeSession,
  readWorkspaceFile,
  writeWorkspaceState,
} from './helpers.ts'

/** 附件对象存储根。 */
function objectsRoot(dshHome: string): string {
  return join(dshHome, 'attachments', 'v1', 'objects')
}

/** 在夹具根目录写入一个原始字节文件,返回其路径。 */
function writeRawFile(fixture: Fixture, name: string, bytes: Buffer): string {
  const file = join(fixture.root, name)
  writeFileSync(file, bytes)
  return file
}

/** 逐帧解压文件并把明文按帧顺序返回,用于验证帧边界是否精确。 */
function decodeFramesInOrder(file: string, spans: readonly { start: number; end: number }[]): string[] {
  const buffer = readFileSync(file)
  return spans.map(span => zstdDecompressSync(buffer.subarray(span.start, span.end)).toString('utf8'))
}

describe('readFrameSpans', () => {
  test('单帧日志定位出唯一的帧范围', () => {
    const fixture = makeFixture()
    try {
      const file = writeRawFile(fixture, 'single.jsonl.zstd', encodeZstdFrames(['{"type":"session"}']))
      const result = readFrameSpans(file)
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.spans.length, 1)
      assert.deepEqual(decodeFramesInOrder(file, result.spans), ['{"type":"session"}'])
    } finally {
      fixture.cleanup()
    }
  })

  test('多帧拼接按帧头与块头逐段推进', () => {
    const fixture = makeFixture()
    try {
      const records = ['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']
      const file = writeRawFile(fixture, 'multi.jsonl.zstd', encodeZstdFrames(records))
      const result = readFrameSpans(file)
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.spans.length, records.length)
      assert.deepEqual(decodeFramesInOrder(file, result.spans), records)
    } finally {
      fixture.cleanup()
    }
  })

  test('尾帧被截断时返回 failed 而不尽力而为', () => {
    const fixture = makeFixture()
    try {
      const frames = encodeZstdFrames(['{"type":"a"}', '{"type":"b"}'])
      const file = writeRawFile(fixture, 'torn.jsonl.zstd', frames.subarray(0, frames.length - 3))
      const result = readFrameSpans(file)
      assert.equal(result.kind, 'failed')
      if (result.kind !== 'failed') return
      assert.match(result.reason, /truncated zstd frame/)
    } finally {
      fixture.cleanup()
    }
  })

  test('非 zstd 内容返回 failed', () => {
    const fixture = makeFixture()
    try {
      const file = writeRawFile(fixture, 'plain.jsonl.zstd', Buffer.from('not a zstd container', 'utf8'))
      const result = readFrameSpans(file)
      assert.equal(result.kind, 'failed')
      if (result.kind !== 'failed') return
      assert.match(result.reason, /invalid zstd frame magic/)
    } finally {
      fixture.cleanup()
    }
  })

  test('空文件按不可信处理', () => {
    const fixture = makeFixture()
    try {
      const file = writeRawFile(fixture, 'empty.jsonl.zstd', Buffer.alloc(0))
      const result = readFrameSpans(file)
      assert.equal(result.kind, 'failed')
      if (result.kind !== 'failed') return
      assert.match(result.reason, /is empty/)
    } finally {
      fixture.cleanup()
    }
  })

  test('路径不可读时返回 failed 而不是抛出', () => {
    const fixture = makeFixture()
    try {
      const result = readFrameSpans(join(fixture.root, 'missing.jsonl.zstd'))
      assert.equal(result.kind, 'failed')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('collectLogDigests', () => {
  test('多帧日志中的全部字面摘要被收齐并去重', () => {
    const fixture = makeFixture()
    try {
      const first = makeDigest('a')
      const second = makeDigest('b')
      const records = [
        JSON.stringify({ type: 'user/message', attachment: `sha256:${first}` }),
        JSON.stringify({ type: 'tool/result', text: `duplicate sha256:${first}` }),
        JSON.stringify({ type: 'tool/result', attachment: `sha256:${second}` }),
      ]
      const file = writeRawFile(fixture, 'refs.jsonl.zstd', encodeZstdFrames(records))
      const result = collectLogDigests(file)
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.deepEqual([...result.digests].sort(), [first, second].sort())
    } finally {
      fixture.cleanup()
    }
  })

  test('未压缩日志按行收集字面摘要', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('c')
      makePlainReferenceLog(fixture.dshHome, 'proj-a', 'session-plain', [digest])
      const file = join(fixture.dshHome, 'sessions', '--proj-a--', 'session-plain', 'session.v4.jsonl')
      const result = collectLogDigests(file)
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.deepEqual([...result.digests], [digest])
    } finally {
      fixture.cleanup()
    }
  })

  test('未压缩日志不参与帧扫描', () => {
    const fixture = makeFixture()
    try {
      makePlainReferenceLog(fixture.dshHome, 'proj-a', 'session-plain', [makeDigest('d')])
      const file = join(fixture.dshHome, 'sessions', '--proj-a--', 'session-plain', 'session.v4.jsonl')
      assert.equal(readFrameSpans(file).kind, 'failed')
    } finally {
      fixture.cleanup()
    }
  })

  test('不足 64 位的十六进制串不产生引用', () => {
    const fixture = makeFixture()
    try {
      const records = [
        JSON.stringify({ type: 'user/message', text: 'omitted sha256:12345678' }),
        JSON.stringify({ type: 'user/message', text: `overlong sha256:${'a'.repeat(65)}` }),
      ]
      const file = writeRawFile(fixture, 'short.jsonl.zstd', encodeZstdFrames(records))
      const result = collectLogDigests(file)
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('截断的尾帧使整份日志不可信', () => {
    const fixture = makeFixture()
    try {
      const frames = encodeZstdFrames(['{"type":"a"}', '{"type":"b"}'])
      const file = writeRawFile(fixture, 'torn.jsonl.zstd', frames.subarray(0, frames.length - 2))
      const result = collectLogDigests(file)
      assert.equal(result.kind, 'failed')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('collectReclaimableObjects', () => {
  test('只被待删会话引用的摘要进入候选集合', () => {
    const fixture = makeFixture()
    try {
      const shared = makeDigest('a')
      const liveOnly = makeDigest('b')
      const deletedOnly = makeDigest('c')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-live', 'session.v4.jsonl.zstd', [shared, liveOnly])
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [shared, deletedOnly])
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.deepEqual([...result.digests], [deletedOnly])
    } finally {
      fixture.cleanup()
    }
  })

  test('被两个存活会话共享的摘要不可回收', () => {
    const fixture = makeFixture()
    try {
      const shared = makeDigest('e')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-live-1', 'session.v4.jsonl.zstd', [shared])
      makeReferenceLog(fixture.dshHome, 'proj-b', 'session-live-2', 'session.v4.jsonl.zstd', [shared])
      makeReferenceLog(fixture.dshHome, 'proj-b', 'session-old', 'session.v4.jsonl.zstd', [shared])
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('无任何会话引用的孤儿对象不在候选集合内', () => {
    const fixture = makeFixture()
    try {
      const orphan = makeDigest('f')
      const orphanFile = makeAttachmentObject(fixture.dshHome, orphan)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [makeDigest('1')])
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.has(orphan), false)
      assert.equal(existsSync(orphanFile), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('同目录内多代日志全部参与扫描', () => {
    const fixture = makeFixture()
    try {
      const older = makeDigest('2')
      const newer = makeDigest('3')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v3.jsonl.zstd', [older])
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [newer])
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.deepEqual([...result.digests].sort(), [older, newer].sort())
    } finally {
      fixture.cleanup()
    }
  })

  test('保留名单内的会话按存活处理', () => {
    const fixture = makeFixture()
    try {
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [makeDigest('4')])
      const result = collectReclaimableObjects(
        fixture.dshHome,
        new Set(['session-old']),
        new Set(['session-old']),
      )
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('不在待删与保留名单中的会话目录按存活处理', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('5')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-other', 'session.v4.jsonl.zstd', [digest])
      makeReferenceLog(fixture.dshHome, 'proj-b', 'session-old', 'session.v4.jsonl.zstd', [digest])
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('待删会话日志不可读时整体放弃回收', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-old', 120, 'not a zstd container')
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'aborted')
    } finally {
      fixture.cleanup()
    }
  })

  test('存活会话日志不可读时整体放弃回收', () => {
    const fixture = makeFixture()
    try {
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [makeDigest('6')])
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120, 'not a zstd container')
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'aborted')
      if (result.kind !== 'aborted') return
      assert.match(result.reason, /invalid zstd frame magic/)
    } finally {
      fixture.cleanup()
    }
  })

  test('附件暂存目录非空时放弃本次回收', () => {
    const fixture = makeFixture()
    try {
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [makeDigest('7')])
      makeAttachmentTmpEntry(fixture.dshHome)
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'aborted')
      if (result.kind !== 'aborted') return
      assert.match(result.reason, /may be in flight/)
    } finally {
      fixture.cleanup()
    }
  })

  test('会话目录内没有规范日志时整体放弃回收', () => {
    const fixture = makeFixture()
    try {
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [makeDigest('b')])
      const dir = join(fixture.dshHome, 'sessions', '--proj-b--', 'session-none')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'notes.txt'), 'no canonical log here', 'utf8')
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'aborted')
      if (result.kind !== 'aborted') return
      assert.match(result.reason, /no canonical session log/)
    } finally {
      fixture.cleanup()
    }
  })

  test('项目分组为符号链接时其会话仍参与引用计数', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('a')
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      const externalSession = join(fixture.root, 'external-project', 'session-external')
      mkdirSync(externalSession, { recursive: true })
      writeFileSync(join(externalSession, 'session.v4.jsonl.zstd'), encodeZstdFrames([
        JSON.stringify({ type: 'session', id: 'session-external' }),
        JSON.stringify({ type: 'user/message', attachment: `sha256:${digest}` }),
      ]))
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(join(fixture.root, 'external-project'), join(fixture.dshHome, 'sessions', '--ext--'), linkType)
      const result = collectReclaimableObjects(fixture.dshHome, new Set(['session-old']))
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })

  test('没有待删会话时返回空集合且不检查暂存目录', () => {
    const fixture = makeFixture()
    try {
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120, 'not a zstd container')
      makeAttachmentTmpEntry(fixture.dshHome)
      const result = collectReclaimableObjects(fixture.dshHome, new Set())
      assert.equal(result.kind, 'ok')
      if (result.kind !== 'ok') return
      assert.equal(result.digests.size, 0)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('measureAttachmentObjects', () => {
  test('只统计真实存在的对象', () => {
    const fixture = makeFixture()
    try {
      const present = makeDigest('8')
      makeAttachmentObject(fixture.dshHome, present, 2048)
      const measured = measureAttachmentObjects(fixture.dshHome, [present, makeDigest('9')])
      assert.deepEqual(measured, { count: 1, bytes: 2048 })
    } finally {
      fixture.cleanup()
    }
  })

  test('对象存储根不存在时统计为零', () => {
    const fixture = makeFixture()
    try {
      assert.deepEqual(measureAttachmentObjects(fixture.dshHome, [makeDigest('a')]), { count: 0, bytes: 0 })
    } finally {
      fixture.cleanup()
    }
  })
})

describe('removeAttachmentObjects', () => {
  test('移除真实文件并清理清空后的分片目录', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('a')
      const file = makeAttachmentObject(fixture.dshHome, digest, 32)
      const result = removeAttachmentObjects(fixture.dshHome, [digest])
      assert.equal(result.removed, 1)
      assert.equal(result.bytes, 32)
      assert.deepEqual(result.failures, [])
      assert.equal(existsSync(file), false)
      assert.equal(existsSync(join(objectsRoot(fixture.dshHome), digest.slice(0, 2))), false)
    } finally {
      fixture.cleanup()
    }
  })

  test('分片目录内仍有其他对象时保留目录', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('a')
      const sibling = `aa${'b'.repeat(62)}`
      makeAttachmentObject(fixture.dshHome, digest, 8)
      makeAttachmentObject(fixture.dshHome, sibling, 8)
      const result = removeAttachmentObjects(fixture.dshHome, [digest])
      assert.equal(result.removed, 1)
      assert.equal(existsSync(join(objectsRoot(fixture.dshHome), 'aa')), true)
      assert.equal(existsSync(attachmentObjectPath(fixture.dshHome, sibling)), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('不存在的摘要被跳过且不计为失败', () => {
    const fixture = makeFixture()
    try {
      const result = removeAttachmentObjects(fixture.dshHome, [makeDigest('b')])
      assert.deepEqual(result, { removed: 0, bytes: 0, failures: [] })
    } finally {
      fixture.cleanup()
    }
  })

  test('摘要形态非法时不触碰文件系统', () => {
    const fixture = makeFixture()
    try {
      mkdirSync(objectsRoot(fixture.dshHome), { recursive: true })
      const result = removeAttachmentObjects(fixture.dshHome, ['../../etc/passwd'])
      assert.deepEqual(result, { removed: 0, bytes: 0, failures: [] })
    } finally {
      fixture.cleanup()
    }
  })

  test('分片目录指向外部时不得删除目标', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('c')
      const external = join(fixture.root, 'external')
      mkdirSync(external, { recursive: true })
      const externalFile = join(external, digest)
      writeFileSync(externalFile, Buffer.alloc(16, 3))
      mkdirSync(objectsRoot(fixture.dshHome), { recursive: true })
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(external, join(objectsRoot(fixture.dshHome), digest.slice(0, 2)), linkType)
      const result = removeAttachmentObjects(fixture.dshHome, [digest])
      assert.equal(result.removed, 0)
      assert.equal(result.failures.length, 1)
      assert.match(result.failures[0] ?? '', /resolves outside/)
      assert.equal(existsSync(externalFile), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('对象文件是指向外部的符号链接时不得删除目标', { skip: process.platform === 'win32' }, () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('d')
      const externalFile = join(fixture.root, 'external-object')
      writeFileSync(externalFile, Buffer.alloc(16, 3))
      const link = attachmentObjectPath(fixture.dshHome, digest)
      mkdirSync(join(objectsRoot(fixture.dshHome), digest.slice(0, 2)), { recursive: true })
      symlinkSync(externalFile, link)
      const result = removeAttachmentObjects(fixture.dshHome, [digest])
      assert.equal(result.removed, 0)
      assert.equal(result.failures.length, 1)
      assert.equal(existsSync(externalFile), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('提供备份目录时对象被移动而非删除', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('e')
      const file = makeAttachmentObject(fixture.dshHome, digest, 24)
      const backupDir = join(fixture.root, 'backup')
      const result = removeAttachmentObjects(fixture.dshHome, [digest], { backupDir })
      assert.equal(result.removed, 1)
      assert.equal(result.bytes, 24)
      assert.equal(existsSync(file), false)
      assert.equal(existsSync(join(backupDir, 'attachments', 'objects', 'ee', digest)), true)
    } finally {
      fixture.cleanup()
    }
  })
})

describe('applyClean 附件回收', () => {
  test('回收只被待删会话引用的对象并保留存活会话引用的对象', () => {
    const fixture = makeFixture()
    try {
      const deletedOnly = makeDigest('a')
      const shared = makeDigest('b')
      const deletedFile = makeAttachmentObject(fixture.dshHome, deletedOnly, 64)
      const sharedFile = makeAttachmentObject(fixture.dshHome, shared, 64)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [deletedOnly, shared])
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-live', 'session.v4.jsonl.zstd', [shared])
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old'], ['session-old', 'session-live']))
      const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      assert.deepEqual(outcome.attachments, { removedCount: 1, removedBytes: 64, failures: [] })
      assert.equal(existsSync(deletedFile), false)
      assert.equal(existsSync(sharedFile), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('--keep-attachments 不回收任何对象且会话照常删除', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('c')
      const file = makeAttachmentObject(fixture.dshHome, digest, 32)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old']))
      const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true, keepAttachments: true })
      assert.equal(outcome.removedCount, 1)
      assert.equal(outcome.attachments, undefined)
      assert.equal(existsSync(file), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
    } finally {
      fixture.cleanup()
    }
  })

  test('--backup 模式下对象移入备份目录', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('d')
      const file = makeAttachmentObject(fixture.dshHome, digest, 40)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old']))
      const backupDir = join(fixture.root, 'backup')
      const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true, backupDir })
      assert.equal(outcome.removedCount, 1)
      assert.equal(outcome.attachments?.removedCount, 1)
      assert.equal(outcome.attachments?.removedBytes, 40)
      assert.equal(existsSync(file), false)
      assert.equal(existsSync(join(backupDir, 'attachments', 'objects', 'dd', digest)), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('存活会话日志不可读时跳过回收,会话删除与配置同步不受影响', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('e')
      const file = makeAttachmentObject(fixture.dshHome, digest, 16)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      makeSession(fixture.dshHome, 'proj-a', 'session-live', 120, 'not a zstd container')
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old'], ['session-old', 'session-live']))
      const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      assert.equal(outcome.attachments?.skippedReason !== undefined, true)
      assert.deepEqual(outcome.attachments?.failures, [])
      assert.equal(existsSync(file), true)
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).global.archivedSessionIds, [])
      assert.deepEqual(readWorkspaceFile(fixture.dshHome).tables.workspaces['ws-a']!.sessionIds, ['session-live'])
    } finally {
      fixture.cleanup()
    }
  })

  test('附件暂存目录非空时跳过回收,会话删除不受影响', () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('f')
      const file = makeAttachmentObject(fixture.dshHome, digest, 16)
      makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      makeAttachmentTmpEntry(fixture.dshHome)
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old']))
      const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
      const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
      assert.equal(outcome.removedCount, 1)
      assert.equal(outcome.attachments?.skippedReason !== undefined, true)
      assert.equal(existsSync(file), true)
    } finally {
      fixture.cleanup()
    }
  })

  test('会话删除失败时其引用对象保留', { skip: !canSimulateUnreadableDir() }, () => {
    const fixture = makeFixture()
    try {
      const digest = makeDigest('1')
      const file = makeAttachmentObject(fixture.dshHome, digest, 16)
      const sessionDir = makeReferenceLog(fixture.dshHome, 'proj-a', 'session-old', 'session.v4.jsonl.zstd', [digest])
      writeWorkspaceState(fixture.dshHome, baseWorkspaceState(['session-old']))
      chmodSync(sessionDir, 0o555)
      try {
        const plan = buildPlan(fixture.dshHome, ['session-old'], 30, false)
        const outcome = applyClean(fixture.dshHome, plan, { updateConfig: true })
        assert.equal(outcome.removedCount, 0)
        assert.equal(outcome.failures.length, 1)
        assert.equal(outcome.attachments?.removedCount, 0)
        assert.equal(existsSync(file), true)
      } finally {
        chmodSync(sessionDir, 0o755)
      }
    } finally {
      fixture.cleanup()
    }
  })
})
