/**
 * 运行中的 dsh 进程探测,检测失败时返回 false 由调用方统一输出提醒。
 * dsh 宿主有两类映像:通过 node.exe 运行的 CLI 与 web,以及 desktop 应用可执行文件。
 * desktop 宿主由 spawn(process.execPath, ...) 以 ELECTRON_RUN_AS_NODE 启动,映像名取自 productName,命令行与路径都不含 dsh。
 * 探测会排除自身进程与父进程,避免 npm 安装路径含有 dsh 字样时把自己误判为运行中的 dsh。
 * @module dsh-clean-sessions/detect
 */

import { execFileSync } from 'node:child_process'

/** 进程探测的超时上限,单位为毫秒,防止检测命令挂起拖慢主流程。 */
const PROBE_TIMEOUT_MILLIS = 10_000

/** 以 node.exe 运行的宿主映像名,用于把 CLI 宿主与无关的 node 进程区分开。 */
const NODE_IMAGE_NAME = 'node.exe'

/** CLI 与 web 宿主的命令行特征,命令行中出现 dsh 模块名或路径。 */
const DSH_COMMAND_TOKEN = 'dsh'

/** desktop 宿主入口模块的路径特征,开发模式下宿主以 electron.exe 启动,映像名不含 dsh。 */
const DSH_DESKTOP_HOST_TOKEN = 'dsh-desktop-host'

/** desktop 应用可执行文件名特征,来源为 electron-builder 的 productName 与候选命名。 */
const DESKTOP_IMAGE_TOKENS: readonly string[] = ['deepseek harness', 'dsh-desktop']

/** POSIX 侧 pgrep 的扩展正则,同时匹配 dsh 命令行与 desktop 应用路径;pgrep 无跨平台可用的大小写忽略选项,故用字符类覆盖大小写。 */
const POSIX_HOST_PATTERN = '[Dd][Ss][Hh]|[Dd]eep[Ss]eek [Hh]arness'

/** Windows 探测输出中 pid、映像名与命令行之间的字段分隔符。 */
const RECORD_SEPARATOR = '\t'

/** 分隔符字符码,PowerShell 侧按同一个码生成分隔符,避免两侧定义漂移。 */
const RECORD_SEPARATOR_CHAR_CODE = RECORD_SEPARATOR.charCodeAt(0)

/** 进程探测的可注入输入,测试时用于固定平台与进程标识。 */
export interface DetectInput {
  /** 目标平台,缺省为当前进程平台。 */
  platform?: NodeJS.Platform
  /** 当前进程 id,缺省为 process.pid。 */
  selfPid?: number
  /** 父进程 id,缺省为 process.ppid。 */
  selfPpid?: number | undefined
}

/** Windows 探测输出中的一条进程记录。 */
export interface ProcessRecord {
  /** 进程 id。 */
  readonly pid: number
  /** 映像名,例如 node.exe 或 DeepSeek Harness.exe。 */
  readonly name: string
  /** 完整命令行,系统拒绝读取时为空串。 */
  readonly commandLine: string
}

/** 从 pgrep 输出中筛除自身进程与父进程,仍有剩余时判定存在外部 dsh 进程。 */
export function hasForeignPid(pgrepOutput: string, selfPid: number, selfPpid: number | undefined): boolean {
  const pids = pgrepOutput.split(/\s+/).map(token => Number.parseInt(token, 10))
  return pids.some(pid => Number.isFinite(pid) && isForeignPid(pid, selfPid, selfPpid))
}

/** 判定进程 id 是否既不是自身也不是父进程。 */
function isForeignPid(pid: number, selfPid: number, selfPpid: number | undefined): boolean {
  return pid !== selfPid && (selfPpid === undefined || pid !== selfPpid)
}

/** 解析 Windows 探测输出,字段不足或 pid 非法的行不参与判定。 */
export function parseProcessRecords(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = []
  for (const line of output.split(/\r?\n/)) {
    const record = parseProcessRecord(line)
    if (record !== undefined) records.push(record)
  }
  return records
}

/** 按前两个分隔符切分单行,命令行内部出现制表符不会破坏解析。 */
function parseProcessRecord(line: string): ProcessRecord | undefined {
  const pidEnd = line.indexOf(RECORD_SEPARATOR)
  if (pidEnd < 0) return undefined
  const nameEnd = line.indexOf(RECORD_SEPARATOR, pidEnd + 1)
  if (nameEnd < 0) return undefined
  const pid = Number.parseInt(line.slice(0, pidEnd), 10)
  if (!Number.isFinite(pid)) return undefined
  return { pid, name: line.slice(pidEnd + 1, nameEnd), commandLine: line.slice(nameEnd + 1) }
}

/** 判定进程是否属于需要用户退出的外部 dsh 宿主,自身进程与父进程始终排除。 */
export function isExternalDshHost(record: ProcessRecord, selfPid: number, selfPpid: number | undefined): boolean {
  if (!isForeignPid(record.pid, selfPid, selfPpid)) return false
  const name = record.name.toLowerCase()
  const commandLine = record.commandLine.toLowerCase()
  if (isDesktopHostImage(name)) return true
  if (commandLine.includes(DSH_DESKTOP_HOST_TOKEN)) return true
  return name === NODE_IMAGE_NAME && commandLine.includes(DSH_COMMAND_TOKEN)
}

/** 映像名本身带 desktop 应用特征时无需再看命令行。 */
function isDesktopHostImage(lowerName: string): boolean {
  return DESKTOP_IMAGE_TOKENS.some(token => lowerName.includes(token))
}

/** 从 Windows 探测输出中判定是否存在外部 dsh 宿主。 */
export function hasForeignDshHost(probeOutput: string, selfPid: number, selfPpid: number | undefined): boolean {
  return parseProcessRecords(probeOutput).some(record => isExternalDshHost(record, selfPid, selfPpid))
}

/**
 * 构造 Windows 进程探测的 PowerShell 参数,输出制表符分隔的进程记录。
 * Where-Object 只做粗筛以限制输出规模,最终判定由 isExternalDshHost 完成,粗筛条件必须覆盖该谓词的全部命中。
 */
export function buildWindowsProbeArgs(selfPid: number, selfPpid: number | undefined): string[] {
  const parentFilter = selfPpid === undefined ? '' : ` AND ParentProcessId <> ${selfPpid}`
  const desktopNameFilter = DESKTOP_IMAGE_TOKENS.map(token => `$_.Name -match '${token}'`).join(' -or ')
  const script =
    `Get-CimInstance Win32_Process -Filter "ProcessId <> ${selfPid}${parentFilter}" ` +
    `| Where-Object { $_.CommandLine -match '${DSH_COMMAND_TOKEN}' -or ${desktopNameFilter} } ` +
    `| ForEach-Object { @($_.ProcessId, $_.Name, $_.CommandLine) -join [char]${RECORD_SEPARATOR_CHAR_CODE} }`
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/** 构造 POSIX 进程探测参数,pgrep 按扩展正则匹配完整命令行。 */
export function buildPosixProbeArgs(): string[] {
  return ['-f', POSIX_HOST_PATTERN]
}

/** 探测是否有 dsh 进程在运行,Windows 用 PowerShell 枚举进程记录,其他平台用 pgrep。 */
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
      return hasForeignDshHost(output, selfPid, selfPpid)
    }
    const output = execFileSync(
      'pgrep',
      buildPosixProbeArgs(),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MILLIS },
    )
    return hasForeignPid(output, selfPid, selfPpid)
  } catch {
    return false
  }
}
