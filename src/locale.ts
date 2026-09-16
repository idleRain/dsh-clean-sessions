/**
 * 主机语言检测:用于在未显式指定语言时决定 CLI 提示文本。
 * 中文简繁一律归为 zh,其余语言一律归为 en。
 * @module dsh-clean-sessions/locale
 */

import { execFileSync } from 'node:child_process'
import type { Language } from './types.ts'

/** POSIX 区域环境变量的检查顺序,LC_ALL 优先级最高。 */
const POSIX_LOCALE_KEYS = ['LC_ALL', 'LC_MESSAGES', 'LC_CTYPE', 'LANG'] as const

/** 探测 Windows UI 语言的超时上限,单位为毫秒。 */
const PROBE_TIMEOUT_MILLIS = 5_000

/** 主机语言探测的可注入输入,测试时用于固定环境与平台。 */
export interface HostLanguageInput {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  uiCulture: string | null
  intlLocale: string
}

/** 在 Windows 上用 PowerShell 读取当前 UI 语言,读取失败时返回 null。 */
function probeWindowsUiCulture(): string | null {
  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[Globalization.CultureInfo]::CurrentUICulture.Name'],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MILLIS, windowsHide: true },
    )
    return output.trim().toLowerCase()
  } catch {
    return null
  }
}

/** 判断区域标识是否属于中文,zh-CN、zh-TW、zh-Hant 等前缀均为 zh。 */
function isChineseLocale(locale: string): boolean {
  return locale.trim().toLowerCase().startsWith('zh')
}

/**
 * 检测主机语言:依次检查区域环境变量、Windows UI 语言与 Intl 默认区域,
 * 任一命中中文即返回 zh,否则返回 en。
 */
export function detectHostLanguage(input: Partial<HostLanguageInput> = {}): Language {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const uiCulture = input.uiCulture ?? (platform === 'win32' ? probeWindowsUiCulture() : null)
  const intlLocale = input.intlLocale ?? Intl.DateTimeFormat().resolvedOptions().locale
  for (const key of POSIX_LOCALE_KEYS) {
    if (isChineseLocale(env[key] ?? '')) return 'zh'
  }
  if (platform === 'win32' && uiCulture !== null && isChineseLocale(uiCulture)) return 'zh'
  if (isChineseLocale(intlLocale)) return 'zh'
  return 'en'
}
