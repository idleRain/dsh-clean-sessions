# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### 新增 / Features

- 新增子代理级联删除与附件对象回收。子代理级联:默认删除归档会话时一并删除其后代中 `origin === 'subagent'` 的子代理会话并递归到多级,基于会话 fork 出来的独立会话及其衍生后代不受影响;新增 `--keep-children` 只删除归档名单内的会话;后代最近仍有写入或位于 sessions 根目录之外时,其祖先本次保留并在预览中给出可操作原因,后代目录不可核实时以退出码 `1` 终止。附件回收:按会话日志中的 `sha256:` 摘要字面引用做引用计数,默认只回收仅被本次删除的会话引用的 `attachments/v1/objects` 内容寻址对象,仍被任何存活会话引用的对象保留;新增 `--keep-attachments` 完全不触碰附件存储;`attachments/v1/tmp/` 非空或不可枚举、任一会话目录不可枚举、任一会话目录缺少规范日志、任一日志的 zstd 帧结构非法或尾帧被截断、任一会话日志无法完整读取时整体放弃回收,且不影响会话目录删除与配置同步;`--backup` 模式下对象被移入 `<backupDir>/attachments/objects/`;`attachments/v1/request-images/`、`cache/attachments/request-images/` 与 `llm-deepseek/files-v3.json` 不在触碰范围内。
- Subagent cascade deletion and attachment object reclamation are new. Cascade: removing an archived session now also removes the `origin === 'subagent'` subagent sessions it derived, recursively to any depth, while sessions forked from it and their own descendants stay untouched; the new `--keep-children` flag limits a run to the archived sessions. When a descendant was written recently or resolves outside the sessions root, its ancestors are kept and the preview names the actionable reason, and an unverifiable descendant directory exits with code `1`. Reclamation: references are counted from the literal `sha256:` digests in session logs, and by default only `attachments/v1/objects` content-addressed objects referenced solely by the sessions removed in this run are reclaimed, while objects still referenced by a surviving session are kept; the new `--keep-attachments` flag leaves the attachment store untouched. A non-empty or unlistable `attachments/v1/tmp/`, an unlistable session directory, a session directory without a canonical log, an invalid or truncated zstd frame, or a session log that cannot be read in full aborts the whole reclamation without affecting session deletion or the config sync, and under `--backup` the objects move into `<backupDir>/attachments/objects/`. `attachments/v1/request-images/`, `cache/attachments/request-images/` and `llm-deepseek/files-v3.json` are out of scope.

### 修复 / Fixes

- 修复会话根目录缺失或不可读时清空工作区配置的缺陷:默认在修改任何文件之前以退出码 `1` 终止,新增 `--allow-missing-sessions` 显式放行,放行时 `workspace.json` 保持不变;配置同步改为只消费清理计划,仅幽灵条目与本次删除成功的 id 会被摘除;会话目录名改用 `encodeSegment` 编码查找,id 含 `~`、空格或非 ASCII 字符时不再被误判为幽灵条目;home 解析与 DSH 对齐,展开 `~`、`~/`、`~\` 前缀并按当前工作目录绝对化,空白 `$DSH_HOME` 视为未设置;`pinnedSessionIds` 中已消失的 id 一并清理,未知字段保持原样;进程探测补齐 desktop 宿主 `DeepSeek Harness.exe` 与 `dsh-desktop-host`,提示文案改为要求退出 desktop 应用;投影缓存说明订正,per-record 布局是当前布局且其中已消失会话的文档会被清理,单文件布局是历史遗留且不会被触碰;测试夹具文件名由 `session.v3.jsonl.zstd` 更新为 `session.v4.jsonl.zstd`。
- Fixes: a missing or unreadable sessions root no longer wipes the workspace config. The run aborts with exit code `1` before modifying any file, and the new `--allow-missing-sessions` flag is the explicit opt-in that leaves `workspace.json` unchanged. Config sync now consumes only the cleanup plan, so just ghost entries and ids actually removed are dropped. Session directory names are resolved through `encodeSegment`, so ids containing `~`, spaces or non-ASCII characters are located instead of being mistaken for ghost entries. Home resolution matches DSH by expanding `~`, `~/` and `~\` prefixes and absolutizing them against the current working directory, with a blank `$DSH_HOME` treated as unset. `pinnedSessionIds` entries that are gone are pruned while unknown fields are preserved. Process detection now covers the desktop hosts `DeepSeek Harness.exe` and `dsh-desktop-host`, and the message asks users to quit the desktop app. The projection cache notes are corrected so that the per-record layout is the current one and its documents for gone sessions are removed, while the single-file layout is legacy and untouched. The test fixture file name moved from `session.v3.jsonl.zstd` to `session.v4.jsonl.zstd`.

### 破坏性变更 / Breaking changes

- 程序化 API 破坏性变更:`resolveDshHome(configured?, env?)`、`updateWorkspaceConfig(dshHome, goneIds)`、`collectGoneSessionIds(plan, removedIds)` 与 `applyClean(dshHome, plan, options)` 改为新签名,`preflight` 新增可选的第二参数;`projectionCacheLegacyDir` 更名为 `projectionCacheDir`,模块内的 `cleanProjectionCacheLegacy` 更名为 `cleanProjectionCache`;新增导出 `encodeSegment`、`expandHomePath`、`normalizeDshHome`、`inspectSessionsRoot`、`DSH_HOME_ENV`,以及 `PreflightOptions`、`PreflightResult`、`SessionsRootInspection`、`SessionsRootStatus` 类型。
- Breaking changes: the programmatic API changed. `resolveDshHome(configured?, env?)`, `updateWorkspaceConfig(dshHome, goneIds)`, `collectGoneSessionIds(plan, removedIds)` and `applyClean(dshHome, plan, options)` carry new signatures and `preflight` gained an optional second parameter; `projectionCacheLegacyDir` was renamed to `projectionCacheDir` and the module-level `cleanProjectionCacheLegacy` to `cleanProjectionCache`; `encodeSegment`, `expandHomePath`, `normalizeDshHome`, `inspectSessionsRoot`, `DSH_HOME_ENV` and the `PreflightOptions`, `PreflightResult`, `SessionsRootInspection` and `SessionsRootStatus` types are new exports.
- 破坏性行为变更:默认执行不再局限于归档名单。归档会话衍生的 `origin === 'subagent'` 子代理会话即使不在 `archivedSessionIds` 中,也会随父会话一并删除,1.0.0 的"只处理归档名单内的会话"表述不再成立;需要旧范围时加 `--keep-children`。
- Breaking behavior change: a default run is no longer limited to the archive list. `origin === 'subagent'` subagent sessions derived from an archived session are removed together with their parent even when they are absent from `archivedSessionIds`, so the 1.0.0 statement that only archived sessions are touched no longer holds; pass `--keep-children` for the previous scope.

- 命令行破坏性变更:移除 `--yes`,删除前的确认提示不再可跳过;`--apply` 在非交互环境需要 stdin 提供 `y` 或 `yes`,未收到确认输入时按取消处理。
- CLI breaking change: `--yes` is removed and the confirmation prompt can no longer be skipped; under `--apply` a non-interactive run needs `y` or `yes` on stdin and is cancelled when no confirmation input arrives.

## 1.0.0

- 首次发布:清理 DSH(DeepSeek Harness)已归档会话,删除会话目录并同步归档名单与工作区槽位。
- 默认仅预览,`--apply` 才真正修改;删除前有确认提示,非交互环境默认拒绝。
- 支持 `--backup` 备份模式、`--min-age` 活跃守卫、`--include-recent`、`--no-config`、`--home` 与中英双语提示。
- 安全机制:符号链接逃逸防护、瞬时占用重试、配置原子写入、备份目录落点校验、会话 id 格式校验、不可读会话按可能活跃跳过。
- First release: remove archived DSH session directories and sync the archive list and workspace slots, with preview-by-default, confirmation, backup mode, an activity guard, bilingual messages, and layered safety checks.
