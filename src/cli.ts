#!/usr/bin/env node
/**
 * 命令行入口:参数解析、语言解析、前置检查、计划预览与执行、结果汇总。
 * 通过进程参数与模块路径的比较判断是否为直接运行,模块被测试或库代码
 * 导入时不会自动执行主流程。
 * @module dsh-clean-sessions/cli
 */

import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CleanPlan, CliOptions } from './types.ts'
import { ExitCode, LocalizedError, UsageError, type ExitCodeValue } from './errors.ts'
import { makeTranslator, resolveLanguage, type Translate } from './i18n.ts'
import { resolveDshHome } from './paths.ts'
import { preflight, readWorkspaceState } from './config.ts'
import { buildPlan } from './plan.ts'
import { applyClean } from './apply.ts'
import { detectRunningDsh } from './detect.ts'
import { assertBackupDirOutsideHome, formatBytes } from './fsutils.ts'
import { bold, green, red, yellow } from './style.ts'

/** 默认把最近仍可能活跃的归档会话视为可疑的最小空闲间隔,单位为分钟。 */
const DEFAULT_MIN_AGE_MINUTES = 30

/** 解析命令行参数,布尔参数不接受值,值参数同时支持 --flag value 与 --flag=value。 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    yes: false,
    minAgeMinutes: DEFAULT_MIN_AGE_MINUTES,
    includeRecent: false,
    backupDir: undefined,
    updateConfig: true,
    dshHome: resolveDshHome(),
    help: false,
    version: false,
    lang: 'auto',
  }
  for (let index = 0; index < argv.length; index++) {
    const { flag, inlineValue } = splitInlineValue(argv[index] ?? '')
    switch (flag) {
      case '--apply':
        assertNoValue(flag, inlineValue)
        options.apply = true
        break
      case '--yes':
        assertNoValue(flag, inlineValue)
        options.yes = true
        break
      case '--include-recent':
        assertNoValue(flag, inlineValue)
        options.includeRecent = true
        break
      case '--no-config':
        assertNoValue(flag, inlineValue)
        options.updateConfig = false
        break
      case '--help':
        assertNoValue(flag, inlineValue)
        options.help = true
        break
      case '--version':
        assertNoValue(flag, inlineValue)
        options.version = true
        break
      case '--min-age':
        options.minAgeMinutes = parseNonNegativeInt(inlineValue ?? argv[++index], '--min-age')
        break
      case '--backup':
        options.backupDir = parseNonEmptyValue(inlineValue ?? argv[++index], '--backup')
        break
      case '--home':
        options.dshHome = parseNonEmptyValue(inlineValue ?? argv[++index], '--home')
        break
      case '--lang': {
        const value = parseNonEmptyValue(inlineValue ?? argv[++index], '--lang')
        if (value !== 'zh' && value !== 'en') throw new UsageError('langUnknown', { value })
        options.lang = value
        break
      }
      default:
        throw new UsageError('unknownArgument', { argument: argv[index] ?? '' })
    }
  }
  return options
}

/** 把 --flag=value 形式的参数拆成旗标与内联值,普通参数返回原样。 */
function splitInlineValue(argument: string): { flag: string; inlineValue?: string } {
  const eqIndex = argument.indexOf('=')
  if (eqIndex === -1) return { flag: argument }
  return { flag: argument.slice(0, eqIndex), inlineValue: argument.slice(eqIndex + 1) }
}

/** 布尔参数带内联值时抛参数错误。 */
function assertNoValue(flag: string, inlineValue: string | undefined): void {
  if (inlineValue !== undefined) throw new UsageError('unexpectedValue', { flag })
}

/** 解析非负整数参数,非法输入抛出带参数名的错误。 */
function parseNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError('invalidNumber', { flag, value: value ?? '' })
  return parsed
}

/** 解析必须非空的路径参数,空白输入视为非法。 */
function parseNonEmptyValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) throw new UsageError('nonEmptyValue', { flag })
  return value
}

/** 从 package.json 读取版本号,读取失败时返回占位版本。 */
function readVersion(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const packageJson = JSON.parse(readFileSync(join(moduleDir, '..', 'package.json'), 'utf8')) as { version?: string }
    return packageJson.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 大小未知时在计划行中展示的占位文本。 */
const UNKNOWN_SIZE_TEXT = '-'

/** 把可能未知的大小渲染为可读文本,未知时展示占位符。 */
function describeSize(sizeBytes: number | null): string {
  return sizeBytes === null ? UNKNOWN_SIZE_TEXT : formatBytes(sizeBytes)
}

/** 打印清理计划,分别列出待删除、活跃嫌疑排除项、幽灵条目与路径不安全项。 */
function printPlan(plan: CleanPlan, minAgeMinutes: number, t: Translate): void {
  const totalBytes = plan.toDelete.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
  console.log(bold(t('toDeleteHeader', { count: plan.toDelete.length, size: formatBytes(totalBytes) })))
  for (const item of plan.toDelete) {
    console.log(t('planRow', {
      id: item.id,
      project: item.location?.projectDir ?? '-',
      size: describeSize(item.sizeBytes),
      recentMark: item.recent ? t('recentMark') : '',
    }))
  }
  if (plan.recentExcluded.length > 0) {
    console.log(yellow(`\n${t('recentExcludedHeader', { count: plan.recentExcluded.length, minutes: minAgeMinutes })}`))
    for (const item of plan.recentExcluded) {
      console.log(t('planRow', {
        id: item.id,
        project: item.location?.projectDir ?? '-',
        size: describeSize(item.sizeBytes),
        recentMark: '',
      }))
    }
    console.log(t('recentExcludedHint'))
  }
  if (plan.ghosts.length > 0) {
    console.log(`\n${t('ghostsHeader', { count: plan.ghosts.length })}`)
    for (const item of plan.ghosts) {
      console.log(`  ${item.id}`)
    }
    console.log(t('ghostHint'))
  }
  if (plan.unsafe.length > 0) {
    console.log(red(`\n${t('unsafeHeader', { count: plan.unsafe.length })}`))
    for (const item of plan.unsafe) {
      console.log(`  ${item.id}  ${item.location?.projectDir ?? '-'}`)
    }
    console.log(t('unsafeHint'))
  }
}

/** 在终端询问确认问题,非交互环境默认拒绝,输入以 y 或 yes 开头视为同意。 */
async function confirm(promptText: string): Promise<boolean> {
  if (stdin.isTTY !== true) return false
  const readline = createInterface({ input: stdin, output: stdout })
  let answer = ''
  try {
    answer = (await readline.question(`${promptText} [y/N] `)).trim().toLowerCase()
  } catch {
    answer = ''
  } finally {
    readline.close()
  }
  return answer === 'y' || answer === 'yes'
}

/** 执行清理流程:前置检查、读取名单、构建计划、预览或执行删除与配置同步。 */
async function run(options: CliOptions, t: Translate): Promise<ExitCodeValue> {
  console.log(t('dshHome', { path: options.dshHome }))
  const preflightResult = preflight(options.dshHome)
  if (options.backupDir !== undefined) {
    assertBackupDirOutsideHome(options.backupDir, options.dshHome)
  }
  if (!preflightResult.sessionsRootExists) {
    console.warn(yellow(t('sessionsRootMissing', { path: preflightResult.sessionsRootDir })))
  }
  const state = readWorkspaceState(options.dshHome)
  const archivedIds = state.global.archivedSessionIds ?? []
  if (archivedIds.length === 0) {
    console.log(green(t('noArchived')))
    return ExitCode.Ok
  }
  const plan = buildPlan(options.dshHome, archivedIds, options.minAgeMinutes, options.includeRecent)
  printPlan(plan, options.minAgeMinutes, t)
  if (!options.apply) {
    console.log(`\n${t('previewFooter')}`)
    return ExitCode.Ok
  }
  if (plan.toDelete.length === 0 && plan.ghosts.length === 0) {
    console.log(t('nothingToDo'))
    return ExitCode.Ok
  }
  const totalBytes = plan.toDelete.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
  if (!options.yes) {
    const approved = await confirm(t('confirmPrompt', { count: plan.toDelete.length, size: formatBytes(totalBytes) }))
    if (!approved) {
      console.log(t('cancelled'))
      return ExitCode.Ok
    }
  }
  const outcome = applyClean(options.dshHome, archivedIds, plan, {
    backupDir: options.backupDir,
    updateConfig: options.updateConfig,
  })
  console.log(`\n${green(t('removedSummary', { count: outcome.removedCount }))}`)
  console.log(t('cacheCleaned', { count: outcome.cleanedCacheCount }))
  console.log(t('emptiedProjects', {
    count: outcome.emptiedProjects.length,
    list: outcome.emptiedProjects.join(', ') || '-',
  }))
  if (outcome.configError !== undefined) {
    console.error(red(t('configSyncFailed', { detail: outcome.configError })))
  } else if (outcome.configResult !== undefined) {
    console.log(t('configSynced', {
      kept: outcome.configResult.archivedKept,
      slots: outcome.configResult.slotsRemoved,
    }))
  } else {
    console.log(t('configSkipped'))
  }
  if (outcome.failures.length > 0) {
    console.error(red(t('failureHeader', { count: outcome.failures.length })))
    for (const failure of outcome.failures) {
      console.error(`  ${failure}`)
    }
    console.error(red(t('failureHint')))
  }
  if (options.updateConfig) {
    if (detectRunningDsh()) {
      console.warn(yellow(`\n${t('dshRunningWarn')}`))
    } else {
      console.warn(`\n${t('dshMaybeRunning')}`)
    }
  }
  if (options.backupDir !== undefined) {
    console.log(t('backupNotice', { path: options.backupDir }))
  }
  const hasFailure = outcome.failures.length > 0 || outcome.configError !== undefined
  return hasFailure ? ExitCode.PartialFailure : ExitCode.Ok
}

/** 主流程:先解析参数,再按显式语言或主机语言检测生成翻译器,统一收敛错误与退出码。 */
async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const t = makeTranslator(resolveLanguage())
    console.error(red(error instanceof LocalizedError ? t(error.key, error.params) : String(error)))
    process.exitCode = ExitCode.UsageError
    return
  }
  const lang = options.lang === 'auto' ? resolveLanguage() : options.lang
  const t = makeTranslator(lang)
  if (options.version) {
    console.log(t('versionLabel', { version: readVersion() }))
    return
  }
  if (options.help) {
    console.log(t('help'))
    return
  }
  try {
    process.exitCode = await run(options, t)
  } catch (error) {
    if (error instanceof LocalizedError) {
      console.error(red(t(error.key, error.params)))
    } else {
      console.error(red(t('runtimeError', { detail: error instanceof Error ? error.message : String(error) })))
    }
    process.exitCode = ExitCode.RuntimeError
  }
}

// 用 realpath 比较进程入口参数与当前模块路径,兼容 npm 的 bin 符号链接
function isDirectRun(): boolean {
  try {
    if (process.argv[1] === undefined) return false
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  void main()
}
