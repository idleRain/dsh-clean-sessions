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
import type { ApplyOutcome, CleanPlan, CliOptions } from './types.ts'
import { ExitCode, LocalizedError, UsageError, type ExitCodeValue } from './errors.ts'
import { makeTranslator, resolveLanguage, type Translate } from './i18n.ts'
import { normalizeDshHome, resolveDshHome } from './paths.ts'
import { preflight, readWorkspaceState } from './config.ts'
import { buildPlan } from './plan.ts'
import { applyClean } from './apply.ts'
import { collectReclaimableObjects, measureAttachmentObjects } from './attachments.ts'
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
    keepChildren: false,
    keepAttachments: false,
    backupDir: undefined,
    updateConfig: true,
    allowMissingSessions: false,
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
      case '--keep-children':
        assertNoValue(flag, inlineValue)
        options.keepChildren = true
        break
      case '--keep-attachments':
        assertNoValue(flag, inlineValue)
        options.keepAttachments = true
        break
      case '--no-config':
        assertNoValue(flag, inlineValue)
        options.updateConfig = false
        break
      case '--allow-missing-sessions':
        assertNoValue(flag, inlineValue)
        options.allowMissingSessions = true
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
        options.dshHome = normalizeDshHome(parseNonEmptyValue(inlineValue ?? argv[++index], '--home'))
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

/** 血缘诊断最多展示的条数,避免长列表淹没计划主体。 */
const MAX_LINEAGE_DIAGNOSTIC_LINES = 5

/** 打印清理计划,分别列出待删除、级联后代、被阻止的祖先、活跃嫌疑、幽灵条目与逃逸项。 */
function printPlan(plan: CleanPlan, minAgeMinutes: number, t: Translate): void {
  printToDeleteSection(plan, t)
  printCascadeSection(plan, t)
  printBlockedSection(plan, t)
  printRecentSection(plan, minAgeMinutes, t)
  printGhostSection(plan, t)
  printUnsafeSection(plan, t)
  printLineageSection(plan, t)
}

/** 打印归档名单内的待删会话。 */
function printToDeleteSection(plan: CleanPlan, t: Translate): void {
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
}

/** 打印随父会话级联删除的子代理后代,并标注其直接来源。 */
function printCascadeSection(plan: CleanPlan, t: Translate): void {
  if (plan.cascade.length === 0) return
  const totalBytes = plan.cascade.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
  console.log(yellow(`\n${t('cascadeHeader', { count: plan.cascade.length, size: formatBytes(totalBytes) })}`))
  for (const item of plan.cascade) {
    console.log(t('cascadeRow', {
      id: item.id,
      project: item.location?.projectDir ?? '-',
      size: describeSize(item.sizeBytes),
      source: item.cascadeSource ?? '-',
    }))
  }
  console.log(t('cascadeHint'))
}

/** 打印因后代无法处理而保留的归档会话及其原因。 */
function printBlockedSection(plan: CleanPlan, t: Translate): void {
  if (plan.blocked.length === 0) return
  console.log(yellow(`\n${t('blockedHeader', { count: plan.blocked.length })}`))
  for (const item of plan.blocked) {
    console.log(t('blockedRow', {
      id: item.id,
      project: item.location?.projectDir ?? '-',
      reason: item.blockedReason === undefined ? '-' : t(item.blockedReason.key, item.blockedReason.params),
    }))
  }
  console.log(t('blockedHint'))
}

/** 打印最近有写入而被排除的归档会话。 */
function printRecentSection(plan: CleanPlan, minAgeMinutes: number, t: Translate): void {
  if (plan.recentExcluded.length === 0) return
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

/** 打印磁盘上已无目录的配置残留。 */
function printGhostSection(plan: CleanPlan, t: Translate): void {
  if (plan.ghosts.length === 0) return
  console.log(`\n${t('ghostsHeader', { count: plan.ghosts.length })}`)
  for (const item of plan.ghosts) {
    console.log(`  ${item.id}`)
  }
  console.log(t('ghostHint'))
}

/** 打印解析结果逃逸出 sessions 根目录的会话。 */
function printUnsafeSection(plan: CleanPlan, t: Translate): void {
  if (plan.unsafe.length === 0) return
  console.log(red(`\n${t('unsafeHeader', { count: plan.unsafe.length })}`))
  for (const item of plan.unsafe) {
    console.log(`  ${item.id}  ${item.location?.projectDir ?? '-'}`)
  }
  console.log(t('unsafeHint'))
}

/** 打印血缘扫描诊断,超过展示上限的条目只计入总数。 */
function printLineageSection(plan: CleanPlan, t: Translate): void {
  if (plan.lineageWarnings.length === 0) return
  console.log(yellow(`\n${t('lineageDiagnosticsHeader', { count: plan.lineageWarnings.length })}`))
  for (const warning of plan.lineageWarnings.slice(0, MAX_LINEAGE_DIAGNOSTIC_LINES)) {
    console.log(`  ${warning}`)
  }
  console.log(t('lineageDiagnosticsHint'))
}

/**
 * 打印附件对象的预计回收量。
 * 预览阶段只做统计不修改文件;引用无法确认时说明执行阶段会重新校验。
 */
function printAttachmentPreview(options: CliOptions, plan: CleanPlan, t: Translate): void {
  if (options.keepAttachments) {
    console.log(yellow(`\n${t('keepAttachmentsHint')}`))
    return
  }
  const deletedIds = new Set([...plan.toDelete, ...plan.cascade].map(item => item.id))
  if (deletedIds.size === 0) return
  const collected = collectReclaimableObjects(options.dshHome, deletedIds)
  if (collected.kind === 'aborted') {
    console.log(yellow(`\n${t('attachmentsPreviewDeferred', { reason: collected.reason })}`))
    return
  }
  const measured = measureAttachmentObjects(options.dshHome, collected.digests)
  console.log(`\n${t('attachmentsPreview', { count: measured.count, size: formatBytes(measured.bytes) })}`)
}

/** 打印附件对象的实际回收结果,整体跳过时只说明原因。 */
function printAttachmentOutcome(outcome: ApplyOutcome, t: Translate): void {
  const attachments = outcome.attachments
  if (attachments === undefined) return
  if (attachments.skippedReason !== undefined) {
    console.warn(yellow(t('attachmentsSkipped', { detail: attachments.skippedReason })))
    return
  }
  console.log(t('attachmentsReclaimed', {
    count: attachments.removedCount,
    size: formatBytes(attachments.removedBytes),
  }))
  if (attachments.failures.length === 0) return
  console.error(red(t('attachmentsRemovalFailed', { count: attachments.failures.length })))
  for (const failure of attachments.failures) {
    console.error(`  ${failure}`)
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
  const preflightResult = preflight(options.dshHome, { allowMissingSessions: options.allowMissingSessions })
  if (options.backupDir !== undefined) {
    assertBackupDirOutsideHome(options.backupDir, options.dshHome)
  }
  if (preflightResult.sessionsRootStatus !== 'usable') {
    // 根目录不可用时任何 id 都无法核实,既不能删除也不能从配置中摘除
    console.warn(yellow(t('sessionsRootSkipped', { path: preflightResult.sessionsRootDir })))
    return ExitCode.Ok
  }
  const state = readWorkspaceState(options.dshHome)
  const archivedIds = state.global.archivedSessionIds ?? []
  if (archivedIds.length === 0) {
    console.log(green(t('noArchived')))
    return ExitCode.Ok
  }
  const plan = buildPlan(
    options.dshHome,
    archivedIds,
    options.minAgeMinutes,
    options.includeRecent,
    options.keepChildren,
  )
  printPlan(plan, options.minAgeMinutes, t)
  if (options.keepChildren) {
    console.log(yellow(`\n${t('keepChildrenHint')}`))
  }
  printAttachmentPreview(options, plan, t)
  if (!options.apply) {
    console.log(`\n${t('previewFooter')}`)
    return ExitCode.Ok
  }
  if (plan.toDelete.length === 0 && plan.ghosts.length === 0) {
    console.log(t('nothingToDo'))
    return ExitCode.Ok
  }
  const removalCount = plan.toDelete.length + plan.cascade.length
  const totalBytes = [...plan.toDelete, ...plan.cascade].reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
  if (!options.yes) {
    const approved = await confirm(t('confirmPrompt', { count: removalCount, size: formatBytes(totalBytes) }))
    if (!approved) {
      console.log(t('cancelled'))
      return ExitCode.Ok
    }
  }
  const outcome = applyClean(options.dshHome, plan, {
    backupDir: options.backupDir,
    updateConfig: options.updateConfig,
    keepAttachments: options.keepAttachments,
  })
  console.log(`\n${green(t('removedSummary', { count: outcome.removedCount }))}`)
  console.log(t('cascadeRemovedSummary', { count: outcome.cascadeRemovedCount }))
  console.log(t('cacheCleaned', { count: outcome.cleanedCacheCount }))
  console.log(t('emptiedProjects', {
    count: outcome.emptiedProjects.length,
    list: outcome.emptiedProjects.join(', ') || '-',
  }))
  printAttachmentOutcome(outcome, t)
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
  const hasFailure = outcome.failures.length > 0
    || outcome.configError !== undefined
    || (outcome.attachments?.failures.length ?? 0) > 0
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
