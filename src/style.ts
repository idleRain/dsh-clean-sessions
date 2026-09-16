/**
 * 终端样式辅助:仅在支持颜色且未设置 NO_COLOR 时输出 ANSI 颜色码。
 * @module dsh-clean-sessions/style
 */

/** 是否启用颜色输出,遵循 NO_COLOR 环境变量约定。 */
const colorEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true

/** 用指定 ANSI 码包裹文本,未启用颜色时原样返回。 */
function wrap(code: number, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

/** 红色文本,用于错误信息。 */
export const red = (text: string): string => wrap(31, text)

/** 黄色文本,用于警告信息。 */
export const yellow = (text: string): string => wrap(33, text)

/** 绿色文本,用于成功信息。 */
export const green = (text: string): string => wrap(32, text)

/** 加粗文本,用于标题信息。 */
export const bold = (text: string): string => wrap(1, text)
