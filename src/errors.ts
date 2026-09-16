/**
 * 错误类型与退出码约定。
 * 本地化错误携带消息键,由 CLI 层按当前语言渲染;技术性细节保留在 params.detail 中。
 * @module dsh-clean-sessions/errors
 */

import type { MessageKey } from './i18n.ts'

/** 退出码约定:0 成功,1 运行时错误,2 参数错误,3 部分删除失败。 */
export const ExitCode = {
  Ok: 0,
  RuntimeError: 1,
  UsageError: 2,
  PartialFailure: 3,
} as const

/** 退出码的具体数值类型。 */
export type ExitCodeValue = typeof ExitCode[keyof typeof ExitCode]

/** 携带消息键与参数的本地化错误基类,CLI 层负责按语言渲染。 */
export class LocalizedError extends Error {
  readonly key: MessageKey
  readonly params: Record<string, string | number>

  constructor(key: MessageKey, params: Record<string, string | number> = {}) {
    super(key)
    this.name = new.target.name
    this.key = key
    this.params = params
  }
}

/** 参数解析错误,退出码为 2。 */
export class UsageError extends LocalizedError {}

/** 配置文件缺失或结构无效,退出码为 1。 */
export class ConfigError extends LocalizedError {}

/** 前置条件不满足,例如主目录或配置文件不存在,退出码为 1。 */
export class PreconditionError extends LocalizedError {}
