/**
 * zstd 帧结构解析:只按帧头与块头结构推进定位帧边界,不解析被压缩的数据内容。
 * .jsonl.zstd 是按记录逐帧拼接的 zstd 容器,帧边界必须靠结构定位:裸搜魔数会把压缩数据里的
 * 巧合字节当成帧起点;而靠 node:zlib 解压截断输入时抛错来判定截断并不可靠,截断帧在 Node 22 与
 * 24 上会静默产出空明文而不抛任何异常,按错误码分支会误判为"帧已完整"。因此帧是否走完一律由
 * 结构判定,解压只负责把已确认完整的帧换成明文。
 * @module dsh-clean-sessions/zstdFrames
 */

/** zstd 帧魔数,与 DSH 的 ZSTD_MAGIC 一致。 */
const ZSTD_MAGIC = 0xfd2fb528

/** zstd 帧魔数占用的字节数。 */
const ZSTD_MAGIC_BYTES = 4

/** 帧头描述符中必须为 0 的保留位。 */
const ZSTD_RESERVED_HEADER_BITS = 0x18

/** 帧头描述符中的单段标志位,置位表示不含窗口描述字节。 */
const ZSTD_SINGLE_SEGMENT_BIT = 0x20

/** 帧头描述符中的校验和标志位。 */
const ZSTD_CHECKSUM_BIT = 0x04

/** 帧头描述符中的字典标志掩码。 */
const ZSTD_DICTIONARY_FLAG_MASK = 0x03

/** 字典标志取最大值时字典 id 固定占 4 字节。 */
const ZSTD_DICTIONARY_ID_BYTES = 4

/** 帧头描述符中内容大小字段的起始位,用于换算该字段的字节数。 */
const ZSTD_CONTENT_SIZE_FLAG_SHIFT = 6

/** 块头占用的字节数。 */
const ZSTD_BLOCK_HEADER_BYTES = 3

/** 块头中的末块标志位。 */
const ZSTD_LAST_BLOCK_BIT = 1

/** 块头中块类型的起始位。 */
const ZSTD_BLOCK_TYPE_SHIFT = 1

/** 块头中的块类型掩码。 */
const ZSTD_BLOCK_TYPE_MASK = 0x03

/** 块头中块大小的起始位。 */
const ZSTD_BLOCK_SIZE_SHIFT = 3

/** RLE 块类型码,其载荷固定为 1 字节。 */
const ZSTD_BLOCK_TYPE_RLE = 0x01

/** 保留块类型码,出现即判定日志结构非法。 */
const ZSTD_BLOCK_TYPE_RESERVED = 0x03

/** 帧尾校验和占用的字节数。 */
const ZSTD_CHECKSUM_BYTES = 4

/** 帧头推进结果,torn 表示缓冲区在帧内结束。 */
type HeaderAdvance =
  | { kind: 'header'; bodyStart: number; checksum: boolean }
  | { kind: 'torn' }
  | { kind: 'invalid'; reason: string }

/** 单帧推进结果,torn 表示缓冲区在帧内结束。 */
export type FrameAdvance =
  | { kind: 'frame'; end: number }
  | { kind: 'torn' }
  | { kind: 'invalid'; reason: string }

/** 从帧起点推进到帧尾,只按帧头与块头结构判定,不解析被压缩的数据内容。 */
export function advanceOneFrame(buffer: Buffer, start: number): FrameAdvance {
  const header = advanceFrameHeader(buffer, start)
  if (header.kind !== 'header') return header
  return advanceFrameBlocks(buffer, header.bodyStart, header.checksum)
}

/** 解析帧头并算出块区起点,魔数或保留位非法时返回 invalid。 */
function advanceFrameHeader(buffer: Buffer, start: number): HeaderAdvance {
  if (buffer.length - start < ZSTD_MAGIC_BYTES) return { kind: 'torn' }
  if (buffer.readUInt32LE(start) !== ZSTD_MAGIC) {
    return { kind: 'invalid', reason: `invalid zstd frame magic at byte ${start}` }
  }
  const descriptorOffset = start + ZSTD_MAGIC_BYTES
  if (descriptorOffset >= buffer.length) return { kind: 'torn' }
  const descriptor = buffer.readUInt8(descriptorOffset)
  if ((descriptor & ZSTD_RESERVED_HEADER_BITS) !== 0) {
    return { kind: 'invalid', reason: `reserved frame-header bit at byte ${descriptorOffset}` }
  }
  const bodyStart = descriptorOffset + 1 + frameHeaderExtraBytes(descriptor)
  if (bodyStart > buffer.length) return { kind: 'torn' }
  return { kind: 'header', bodyStart, checksum: (descriptor & ZSTD_CHECKSUM_BIT) !== 0 }
}

/** 计算帧头描述符之后的剩余头长度,含窗口描述、字典 id 与内容大小字段。 */
function frameHeaderExtraBytes(descriptor: number): number {
  const contentSizeFlag = descriptor >>> ZSTD_CONTENT_SIZE_FLAG_SHIFT
  const singleSegment = (descriptor & ZSTD_SINGLE_SEGMENT_BIT) !== 0
  const dictionaryFlag = descriptor & ZSTD_DICTIONARY_FLAG_MASK
  const dictionaryBytes = dictionaryFlag === ZSTD_DICTIONARY_FLAG_MASK
    ? ZSTD_DICTIONARY_ID_BYTES
    : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  return (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
}

/** 按块头逐块推进到末块,校验和计入帧尾,载荷越界即判定尾部截断。 */
function advanceFrameBlocks(buffer: Buffer, bodyStart: number, checksum: boolean): FrameAdvance {
  let offset = bodyStart
  for (;;) {
    if (buffer.length - offset < ZSTD_BLOCK_HEADER_BYTES) return { kind: 'torn' }
    const blockHeader = buffer.readUIntLE(offset, ZSTD_BLOCK_HEADER_BYTES)
    offset += ZSTD_BLOCK_HEADER_BYTES
    const blockType = (blockHeader >>> ZSTD_BLOCK_TYPE_SHIFT) & ZSTD_BLOCK_TYPE_MASK
    if (blockType === ZSTD_BLOCK_TYPE_RESERVED) {
      return { kind: 'invalid', reason: `reserved block type at byte ${offset - ZSTD_BLOCK_HEADER_BYTES}` }
    }
    const payloadBytes = blockType === ZSTD_BLOCK_TYPE_RLE ? 1 : blockHeader >>> ZSTD_BLOCK_SIZE_SHIFT
    if (buffer.length - offset < payloadBytes) return { kind: 'torn' }
    offset += payloadBytes
    if ((blockHeader & ZSTD_LAST_BLOCK_BIT) !== 0) break
  }
  const end = checksum ? offset + ZSTD_CHECKSUM_BYTES : offset
  return end > buffer.length ? { kind: 'torn' } : { kind: 'frame', end }
}
