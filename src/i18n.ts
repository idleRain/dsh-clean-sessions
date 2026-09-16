/**
 * 中英双语消息字典与语言解析。
 * 新增消息键时必须同时补充两种语言,键名以 MessageKey 类型约束。
 * @module dsh-clean-sessions/i18n
 */

import type { Language } from './types.ts'
import { detectHostLanguage } from './locale.ts'

/** 中文消息字典,键名即消息键,{name} 为占位符。 */
const zh = {
  help: `用法: dsh-clean-sessions [选项]   或   node src/cli.ts [选项]

清理 DSH 已归档会话:删除名单内会话的日志目录,并同步归档名单与工作区槽位。

选项:
  --apply              真正执行删除与配置更新,默认只输出预览
  --yes                跳过删除前的确认提示,仅配合 --apply 使用
  --min-age <分钟>      最近多少分钟内有写入的归档会话视为可能活跃,默认 30
  --include-recent     强制纳入最近有写入的归档会话,默认排除
  --backup <目录>       把会话目录移入备份目录而非直接删除,目录不能位于 DSH 主目录之内
  --no-config          只删除磁盘目录,不同步 workspace.json 配置
  --home <目录>         指定 DSH 主目录,默认读取 $DSH_HOME 或 ~/.dsh
  --lang <zh|en>       提示语言,默认检测主机语言,中文简繁用中文,其余用英文
  --version            输出版本号
  --help               显示本帮助

安全说明:
  1. 默认仅预览,必须显式传入 --apply 才会修改任何文件。
  2. 若 dsh 正在运行,修改配置后必须重启 dsh,否则内存中的旧名单会被写回。
  3. 附件存储与 session_projcache.json 单文件缓存不会被清理。
`,
  dshHome: 'DSH 主目录: {path}',
  noArchived: '没有已归档的会话,无需处理。',
  toDeleteHeader: '待删除: {count} 个, 合计 {size}',
  planRow: '  {id}  {project}  {size}{recentMark}',
  recentMark: ' [最近有写入]',
  recentExcludedHeader: '以下 {count} 个归档会话在最近 {minutes} 分钟内有写入,视为可能活跃,本次不处理:',
  recentExcludedHint: '确认这些会话已结束运行时,可加 --include-recent 强制纳入,或调低 --min-age。',
  ghostsHeader: '幽灵条目,磁盘上已无目录,仅配置残留: {count} 个',
  ghostHint: '执行 --apply 时会同步从配置中移除这些 id。',
  unsafeHeader: '以下 {count} 个归档会话位于 sessions 根目录之外,疑似符号链接或联接逃逸,已跳过:',
  unsafeHint: '请先人工检查这些目录,确认安全后再处理。',
  previewFooter: '以上为预览,未修改任何文件。确认无误后加 --apply 真正执行。',
  nothingToDo: '没有需要删除的会话。',
  confirmPrompt: '将移除 {count} 个会话,约 {size},是否继续?',
  cancelled: '已取消,未修改任何文件。',
  removedSummary: '已移除会话目录: {count} 个',
  cacheCleaned: '已清理投影缓存遗留文档: {count} 个',
  emptiedProjects: '已移除空项目分组: {count} 个 ({list})',
  configSynced: '配置同步完成: 归档名单剩余 {kept} 个, 移除工作区槽位 {slots} 个',
  configSkipped: '已跳过配置同步,请自行处理 workspace.json。',
  configSyncFailed: '配置同步失败: {detail}。会话目录已删除,请稍后重试或手动处理 workspace.json。',
  failureHeader: '移除失败 {count} 项:',
  failureHint: '会话可能被运行中的 dsh 进程占用,可稍后重试,或先重启 dsh。',
  dshRunningWarn: '检测到 dsh 正在运行:workspace.json 的内存副本仍是旧名单。\n请先重启 dsh,再执行任何工作区或会话操作,否则旧名单会被写回并产生幽灵条目。',
  dshMaybeRunning: '若 dsh 正在运行,请重启后再操作工作区;本机未检测到 dsh 进程则无需处理。',
  backupNotice: '备份目录: {path},确认无误后可手动清空。',
  sessionsRootMissing: '会话目录不存在: {path},所有归档会话将被视为幽灵条目。',
  unknownArgument: '未知参数: {argument}',
  unexpectedValue: '参数 {flag} 不接受值。',
  invalidNumber: '参数 {flag} 需要一个非负整数,实际得到: {value}',
  nonEmptyValue: '参数 {flag} 需要一个非空路径',
  langUnknown: '参数 --lang 只支持 zh 或 en,实际得到: {value}',
  homeMissing: 'DSH 主目录不存在: {path}。请使用 --home 指定,或设置环境变量 {env}。',
  backupInsideHome: '备份目录不能位于 DSH 主目录之内: {backup},请改用主目录之外的路径。',
  configMissing: '未找到配置文件: {path},该 DSH 主目录可能尚未初始化。',
  configUnreadable: '配置文件不可读: {path},错误: {detail}',
  configInvalid: 'workspace.json 结构无效: {detail}',
  runtimeError: '执行失败: {detail}',
  versionLabel: 'dsh-clean-sessions {version}',
} as const

/** 英文消息字典,键集合与中文字典完全一致。 */
const en: Record<keyof typeof zh, string> = {
  help: `Usage: dsh-clean-sessions [options]    or   node src/cli.ts [options]

Clean up archived DSH (DeepSeek Harness) sessions: remove session log
directories and sync the archive list and workspace slots.

Options:
  --apply              Actually delete and update the config; preview by default
  --yes                Skip the confirmation prompt; only with --apply
  --min-age <minutes>  Treat archived sessions written within this many minutes
                       as potentially active; default 30
  --include-recent     Force-include recently written archived sessions
  --backup <dir>       Move session directories into a backup dir instead of
                       deleting; must be outside the DSH home
  --no-config          Only remove on-disk directories, skip workspace.json sync
  --home <dir>         DSH home directory; defaults to $DSH_HOME or ~/.dsh
  --lang <zh|en>       Message language; defaults to the host language, Chinese
                       for any zh locale, otherwise English
  --version            Print the version
  --help               Show this help

Safety notes:
  1. Preview only by default; pass --apply to change anything.
  2. If dsh is running, restart it after the config change, otherwise the
     in-memory archive list is written back and ghost entries reappear.
  3. The attachment store and the session_projcache.json single-file cache
     are never touched.
`,
  dshHome: 'DSH home: {path}',
  noArchived: 'No archived sessions to process.',
  toDeleteHeader: 'To delete: {count} ({size})',
  planRow: '  {id}  {project}  {size}{recentMark}',
  recentMark: ' [recently written]',
  recentExcludedHeader: 'These {count} archived sessions were written within the last {minutes} minutes and are treated as potentially active; skipped:',
  recentExcludedHint: 'If you confirm they have finished, pass --include-recent or lower --min-age.',
  ghostsHeader: 'Ghost entries, no on-disk directory, config-only residue: {count}',
  ghostHint: 'Running --apply removes these ids from the config as well.',
  unsafeHeader: 'These {count} archived sessions resolve outside the sessions root, likely symlink or junction escapes; skipped:',
  unsafeHint: 'Inspect these directories manually and handle them once confirmed safe.',
  previewFooter: 'Preview only, nothing was modified. Pass --apply to execute.',
  nothingToDo: 'Nothing to delete.',
  confirmPrompt: 'Remove {count} sessions, about {size}. Continue?',
  cancelled: 'Cancelled, no changes were made.',
  removedSummary: 'Removed session directories: {count}',
  cacheCleaned: 'Cleaned projection cache legacy documents: {count}',
  emptiedProjects: 'Removed empty project groups: {count} ({list})',
  configSynced: 'Config synced: {kept} archived remain, {slots} workspace slots removed',
  configSkipped: 'Config sync skipped; handle workspace.json yourself.',
  configSyncFailed: 'Config sync failed: {detail}. Session directories were removed; retry later or fix workspace.json manually.',
  failureHeader: 'Failed to remove {count} item(s):',
  failureHint: 'A session may be locked by a running dsh process; retry later or restart dsh first.',
  dshRunningWarn: 'dsh appears to be running: the in-memory copy of workspace.json still holds the old archive list.\nRestart dsh before any workspace or session action, otherwise the old list is written back and ghost entries reappear.',
  dshMaybeRunning: 'If dsh is running, restart it before workspace actions; no dsh process was detected on this machine.',
  backupNotice: 'Backup directory: {path}; empty it manually once verified.',
  sessionsRootMissing: 'Sessions directory does not exist: {path}; all archived sessions will be treated as ghost entries.',
  unknownArgument: 'Unknown argument: {argument}',
  unexpectedValue: 'Argument {flag} does not accept a value.',
  invalidNumber: 'Argument {flag} requires a non-negative integer, got: {value}',
  nonEmptyValue: 'Argument {flag} requires a non-empty path',
  langUnknown: 'Argument --lang supports only zh or en, got: {value}',
  homeMissing: 'DSH home does not exist: {path}. Pass --home or set the {env} environment variable.',
  backupInsideHome: 'Backup directory must not be inside the DSH home: {backup}; choose a path outside the home directory.',
  configMissing: 'Config file not found: {path}; this DSH home may not be initialized.',
  configUnreadable: 'Config file is not readable: {path}; error: {detail}',
  configInvalid: 'workspace.json is invalid: {detail}',
  runtimeError: 'Failed: {detail}',
  versionLabel: 'dsh-clean-sessions {version}',
}

/** 消息键类型,与中文字典的键集合一致。 */
export type MessageKey = keyof typeof zh

/** 全部语言的消息字典,供 translate 按语言索引。 */
const dictionaries: Record<Language, Record<MessageKey, string>> = { zh, en }

/** 解析提示语言:显式 flag 优先,其次 CLEAN_SESSIONS_LANG 环境变量,最后检测主机语言。 */
export function resolveLanguage(
  explicit?: Language,
  env: Record<string, string | undefined> = process.env,
): Language {
  if (explicit === 'zh' || explicit === 'en') return explicit
  const fromEnv = env.CLEAN_SESSIONS_LANG
  if (fromEnv === 'zh' || fromEnv === 'en') return fromEnv
  return detectHostLanguage({ env })
}

/** 按语言与键渲染一条消息,并用参数替换 {name} 占位符。 */
export function translate(
  lang: Language,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text = dictionaries[lang][key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** 翻译函数类型,绑定语言后供各模块调用。 */
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** 绑定语言的翻译函数,避免在调用点重复传语言参数。 */
export function makeTranslator(lang: Language): Translate {
  return (key, params) => translate(lang, key, params)
}
