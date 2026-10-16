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
  --keep-children      只删除归档名单内的会话,不做血缘级联,子代理后代保留在磁盘上
  --keep-attachments   跳过附件对象回收,只被待删会话引用的对象保留在磁盘上
  --backup <目录>       把会话目录移入备份目录而非直接删除,目录不能位于 DSH 主目录之内
  --no-config          只删除磁盘目录,不同步 workspace.json 配置
  --allow-missing-sessions
                       会话根目录缺失或不可用时仍继续执行,此时候选会话无法核实,配置保持不变
  --home <目录>         指定 DSH 主目录,默认读取 $DSH_HOME 或 ~/.dsh
  --lang <zh|en>       提示语言,默认检测主机语言,中文简繁用中文,其余用英文
  --version            输出版本号
  --help               显示本帮助

安全说明:
  1. 默认仅预览,必须显式传入 --apply 才会修改任何文件。
  2. 若 dsh 正在运行,修改配置后必须重启 dsh,否则内存中的旧名单会被写回。
  3. 仅回收只被待删会话引用的 attachments/v1/objects 对象,可加 --keep-attachments 关闭;
     request-images 派生缓存与 session_projcache.json 单文件历史缓存不会被清理。
  4. 默认按血缘级联删除待删会话衍生的子代理会话;fork 出来的会话是独立会话,不会受影响。
`,
  dshHome: 'DSH 主目录: {path}',
  noArchived: '没有已归档的会话,无需处理。',
  toDeleteHeader: '待删除: {count} 个, 合计 {size}',
  planRow: '  {id}  {project}  {size}{recentMark}',
  recentMark: ' [最近有写入]',
  cascadeHeader: '血缘级联纳入删除: {count} 个, 合计 {size}',
  cascadeRow: '  {id}  {project}  {size}  来源: {source}',
  cascadeHint: '级联项是待删会话衍生的子代理会话;基于待删会话 fork 出来的独立会话不受影响。',
  cascadeRemovedSummary: '其中由血缘级联移除: {count} 个',
  blockedHeader: '因血缘后代无法处理,以下 {count} 个归档会话本次保留:',
  blockedRow: '  {id}  {project}  原因: {reason}',
  blockedByRecentDescendant: '后代 {childId} 最近仍有写入',
  blockedByUnsafeDescendant: '后代 {childId} 位于 sessions 根目录之外',
  blockedHint: '删除这些祖先会让无法处理的子代理后代失去父会话;可加 --include-recent 纳入最近有写入的后代,或先人工检查并处理逃逸目录。',
  lineageDiagnosticsHeader: '血缘诊断: {count} 条,以下会话的日志无法读取或缺少会话 id,其子代理关系无法确认:',
  lineageDiagnosticsHint: '请检查对应会话目录的读取权限;诊断只影响血缘识别,不改变已在归档名单内会话的既有归类。',
  keepChildrenHint: '已按 --keep-children 跳过血缘级联,子代理后代仍保留在磁盘上,DSH 界面不再提供触达入口。',
  keepAttachmentsHint: '已按 --keep-attachments 跳过附件回收,attachments/v1/objects 保持不变。',
  attachmentsPreview: '附件对象预计回收: {count} 个, {size}',
  attachmentsPreviewDeferred: '附件回收将在 --apply 时重新校验并执行,本次未完成统计: {reason}',
  attachmentsReclaimed: '已回收附件对象: {count} 个, {size}',
  attachmentsSkipped: '已跳过附件回收: {detail}',
  attachmentsRemovalFailed: '附件对象回收失败 {count} 项:',
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
  cacheCleaned: '已清理投影缓存文档: {count} 个',
  emptiedProjects: '已移除空项目分组: {count} 个 ({list})',
  configSynced: '配置同步完成: 归档名单剩余 {kept} 个, 移除工作区槽位 {slots} 个',
  configSkipped: '已跳过配置同步,请自行处理 workspace.json。',
  configSyncFailed: '配置同步失败: {detail}。会话目录已删除,请稍后重试或手动处理 workspace.json。',
  failureHeader: '移除失败 {count} 项:',
  failureHint: '会话可能被运行中的 dsh 进程占用,可稍后重试,或先重启 dsh。',
  dshRunningWarn: '检测到 dsh 正在运行:workspace.json 的内存副本仍是旧名单。\n请先重启 dsh,再执行任何工作区或会话操作,否则旧名单会被写回并产生幽灵条目。',
  dshMaybeRunning: '本机未探测到 dsh 进程;DeepSeek Harness 桌面应用同样属于 dsh,请确认桌面应用与其他 profile 的宿主进程都已退出,再操作工作区。',
  backupNotice: '备份目录: {path},确认无误后可手动清空。',
  sessionsRootMissing: '会话目录不存在: {path}。请检查 --home 与 $DSH_HOME 是否指向预期的 DSH 主目录;$DSH_HOME 或 profile 的 cordis.patch.yml 的 patch 可能把 sessions 根改到了别处。若确认要跳过清点,可显式加 --allow-missing-sessions。',
  sessionsRootUnavailable: '会话目录不可用: {path},错误: {detail}。请检查该路径是否为可枚举的目录,并核对 --home 与 $DSH_HOME;$DSH_HOME 或 profile 的 cordis.patch.yml 的 patch 可能把 sessions 根改到了别处。',
  sessionDirUnverifiable: '无法确认会话目录是否存在: {path},错误: {detail}。请检查该路径的读取权限后重试,本次未修改任何文件。',
  sessionsRootSkipped: '会话根目录不可用: {path},已按 --allow-missing-sessions 跳过清点。\n配置保持不变:无法核实是否存在的归档会话不会被当作已消失。',
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
  --keep-children      Delete only the archived sessions and skip lineage
                       cascading, leaving subagent descendants on disk
  --keep-attachments   Skip attachment object reclamation, leaving objects that
                       only the deleted sessions referenced on disk
  --backup <dir>       Move session directories into a backup dir instead of
                       deleting; must be outside the DSH home
  --no-config          Only remove on-disk directories, skip workspace.json sync
  --allow-missing-sessions
                       Continue when the sessions root is missing or unusable;
                       candidates cannot be verified and the config stays unchanged
  --home <dir>         DSH home directory; defaults to $DSH_HOME or ~/.dsh
  --lang <zh|en>       Message language; defaults to the host language, Chinese
                       for any zh locale, otherwise English
  --version            Print the version
  --help               Show this help

Safety notes:
  1. Preview only by default; pass --apply to change anything.
  2. If dsh is running, restart it after the config change, otherwise the
     in-memory archive list is written back and ghost entries reappear.
  3. Only attachments/v1/objects entries referenced solely by the deleted
     sessions are reclaimed; pass --keep-attachments to skip that. The derived
     request-images caches and the legacy single-file session_projcache.json
     cache are never touched.
  4. Subagent sessions derived from a session slated for deletion are removed
     with it; forked sessions are independent and stay untouched.
`,
  dshHome: 'DSH home: {path}',
  noArchived: 'No archived sessions to process.',
  toDeleteHeader: 'To delete: {count} ({size})',
  planRow: '  {id}  {project}  {size}{recentMark}',
  recentMark: ' [recently written]',
  cascadeHeader: 'Included by lineage cascade: {count} ({size})',
  cascadeRow: '  {id}  {project}  {size}  from: {source}',
  cascadeHint: 'Cascade entries are subagent sessions derived from a session slated for deletion; sessions forked from it are independent and stay untouched.',
  cascadeRemovedSummary: 'Removed by lineage cascade: {count}',
  blockedHeader: 'Kept because a lineage descendant cannot be handled, {count} archived session(s):',
  blockedRow: '  {id}  {project}  reason: {reason}',
  blockedByRecentDescendant: 'descendant {childId} was written recently',
  blockedByUnsafeDescendant: 'descendant {childId} resolves outside the sessions root',
  blockedHint: 'Deleting these ancestors would orphan subagent descendants that cannot be handled; pass --include-recent to include recently written descendants, or inspect and handle the escaping directories first.',
  lineageDiagnosticsHeader: 'Lineage diagnostics: {count} entry/entries; the subagent relationship of these sessions cannot be confirmed because the log is unreadable or lacks a session id:',
  lineageDiagnosticsHint: 'Check read access to these session directories; diagnostics only affect lineage detection and never change the existing verdict of an archived session.',
  keepChildrenHint: 'Lineage cascading was skipped because --keep-children was given; subagent descendants stay on disk with no entry point left in the DSH interface.',
  keepAttachmentsHint: 'Attachment reclamation was skipped because --keep-attachments was given; attachments/v1/objects is left unchanged.',
  attachmentsPreview: 'Attachment objects expected to be reclaimed: {count} ({size})',
  attachmentsPreviewDeferred: 'Attachment reclamation is verified and executed again under --apply; this preview could not finish the count: {reason}',
  attachmentsReclaimed: 'Reclaimed attachment objects: {count} ({size})',
  attachmentsSkipped: 'Attachment reclamation skipped: {detail}',
  attachmentsRemovalFailed: 'Failed to reclaim {count} attachment object(s):',
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
  cacheCleaned: 'Cleaned projection cache documents: {count}',
  emptiedProjects: 'Removed empty project groups: {count} ({list})',
  configSynced: 'Config synced: {kept} archived remain, {slots} workspace slots removed',
  configSkipped: 'Config sync skipped; handle workspace.json yourself.',
  configSyncFailed: 'Config sync failed: {detail}. Session directories were removed; retry later or fix workspace.json manually.',
  failureHeader: 'Failed to remove {count} item(s):',
  failureHint: 'A session may be locked by a running dsh process; retry later or restart dsh first.',
  dshRunningWarn: 'dsh appears to be running: the in-memory copy of workspace.json still holds the old archive list.\nRestart dsh before any workspace or session action, otherwise the old list is written back and ghost entries reappear.',
  dshMaybeRunning: 'No dsh process was detected on this machine; the DeepSeek Harness desktop app also counts as dsh, so make sure it and the host processes of other profiles have exited before touching workspace data.',
  backupNotice: 'Backup directory: {path}; empty it manually once verified.',
  sessionsRootMissing: 'Sessions directory does not exist: {path}. Check that --home and $DSH_HOME point to the expected DSH home; a patch in $DSH_HOME or the profile cordis.patch.yml can relocate the sessions root. Pass --allow-missing-sessions to skip the scan explicitly.',
  sessionsRootUnavailable: 'Sessions directory is unusable: {path}; error: {detail}. Check that the path is an enumerable directory and verify --home and $DSH_HOME; a patch in $DSH_HOME or the profile cordis.patch.yml can relocate the sessions root.',
  sessionDirUnverifiable: 'Cannot verify whether the session directory exists: {path}; error: {detail}. Check read access to this path and retry; nothing was modified.',
  sessionsRootSkipped: 'Sessions root is unusable: {path}; the scan was skipped because --allow-missing-sessions was given.\nThe config is left unchanged: archived sessions that cannot be verified are never treated as gone.',
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
