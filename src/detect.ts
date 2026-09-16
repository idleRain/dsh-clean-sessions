/**
 * 运行中的 dsh 进程探测,检测失败时返回 false 由调用方统一输出提醒。
 * 探测会排除自身进程与父进程,避免 npm 安装路径含有 dsh 字样时把自己误判为运行中的 dsh。
 * @module dsh-clean-sessions/detect
 */

import { execFileSync } from 'node:child_process'

/** 进程探测的超时上限,单位为毫秒,防止检测命令挂起拖慢主流程。 */
const PROBE_TIMEOUT_MILLIS = 10_000

/** 进程探测的可注入输入,测试时用于固定平台与进程标识。 */
export interface DetectInput {
  /** 目标平台,缺省为当前进程平台。 */
  platform?: NodeJS.Platform
  /** 当前进程 id,缺省为 process.pid。 */
  selfPid?: number
  /** 父进程 id,缺省为 process.ppid。 */
  selfPpid?: number | undefined
}

/** 从 pgrep 输出中筛除自身进程与父进程,仍有剩余时判定存在外部 dsh 进程。 */
export function hasForeignPid(pgrepOutput: string, selfPid: number, selfPpid: number | undefined): boolean {
  const tokens = pgrepOutput.split(/\s+/).filter(token => token.length > 0)
  return tokens.some(token => token !== String(selfPid) && (selfPpid === undefined || token !== String(selfPpid)))
}

/** 构造 Windows 进程探测的 PowerShell 参数,WQL 过滤条件排除自身进程与父进程。 */
export function buildWindowsProbeArgs(selfPid: number, selfPpid: number | undefined): string[] {
  const parentFilter = selfPpid === undefined ? '' : ` AND ParentProcessId <> ${selfPpid}`
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ProcessId <> ${selfPid}${parentFilter}" ` +
    `| Where-Object { $_.CommandLine -match 'dsh' } | Measure-Object | Select-Object -ExpandProperty Count`
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/** 探测是否有 dsh 进程在运行,Windows 用 PowerShell 匹配命令行,其他平台用 pgrep。 */
export function detectRunningDsh(input: DetectInput = {}): boolean {
  const platform = input.platform ?? process.platform
  const selfPid = input.selfPid ?? process.pid
  const selfPpid = input.selfPpid ?? process.ppid
  try {
    if (platform === 'win32') {
      const output = execFileSync(
        'powershell',
        buildWindowsProbeArgs(selfPid, selfPpid),
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MILLIS, windowsHide: true },
      )
      const count = Number.parseInt(output.trim(), 10)
      return Number.isFinite(count) && count > 0
    }
    const output = execFileSync(
      'pgrep',
      ['-f', 'dsh'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MILLIS },
    )
    return hasForeignPid(output, selfPid, selfPpid)
  } catch {
    return false
  }
}
