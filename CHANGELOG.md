# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### 修复 / Fixes

- 修复会话根目录缺失或不可读时清空工作区配置的缺陷:默认在修改任何文件之前以退出码 `1` 终止,新增 `--allow-missing-sessions` 显式放行,放行时 `workspace.json` 保持不变;配置同步改为只消费清理计划,仅幽灵条目与本次删除成功的 id 会被摘除;会话目录名改用 `encodeSegment` 编码查找,id 含 `~`、空格或非 ASCII 字符时不再被误判为幽灵条目;home 解析与 DSH 对齐,展开 `~`、`~/`、`~\` 前缀并按当前工作目录绝对化,空白 `$DSH_HOME` 视为未设置;`pinnedSessionIds` 中已消失的 id 一并清理,未知字段保持原样;进程探测补齐 desktop 宿主 `DeepSeek Harness.exe` 与 `dsh-desktop-host`,提示文案改为要求退出 desktop 应用;投影缓存说明订正,per-record 布局是当前布局且其中已消失会话的文档会被清理,单文件布局是历史遗留且不会被触碰;测试夹具文件名由 `session.v3.jsonl.zstd` 更新为 `session.v4.jsonl.zstd`。
- Fixes: a missing or unreadable sessions root no longer wipes the workspace config. The run aborts with exit code `1` before modifying any file, and the new `--allow-missing-sessions` flag is the explicit opt-in that leaves `workspace.json` unchanged. Config sync now consumes only the cleanup plan, so just ghost entries and ids actually removed are dropped. Session directory names are resolved through `encodeSegment`, so ids containing `~`, spaces or non-ASCII characters are located instead of being mistaken for ghost entries. Home resolution matches DSH by expanding `~`, `~/` and `~\` prefixes and absolutizing them against the current working directory, with a blank `$DSH_HOME` treated as unset. `pinnedSessionIds` entries that are gone are pruned while unknown fields are preserved. Process detection now covers the desktop hosts `DeepSeek Harness.exe` and `dsh-desktop-host`, and the message asks users to quit the desktop app. The projection cache notes are corrected so that the per-record layout is the current one and its documents for gone sessions are removed, while the single-file layout is legacy and untouched. The test fixture file name moved from `session.v3.jsonl.zstd` to `session.v4.jsonl.zstd`.

### 破坏性变更 / Breaking changes

- 程序化 API 破坏性变更:`resolveDshHome(configured?, env?)`、`updateWorkspaceConfig(dshHome, goneIds)`、`collectGoneSessionIds(plan, removedIds)` 与 `applyClean(dshHome, plan, options)` 改为新签名,`preflight` 新增可选的第二参数;`projectionCacheLegacyDir` 更名为 `projectionCacheDir`,模块内的 `cleanProjectionCacheLegacy` 更名为 `cleanProjectionCache`;新增导出 `encodeSegment`、`expandHomePath`、`normalizeDshHome`、`inspectSessionsRoot`、`DSH_HOME_ENV`,以及 `PreflightOptions`、`PreflightResult`、`SessionsRootInspection`、`SessionsRootStatus` 类型。
- Breaking changes: the programmatic API changed. `resolveDshHome(configured?, env?)`, `updateWorkspaceConfig(dshHome, goneIds)`, `collectGoneSessionIds(plan, removedIds)` and `applyClean(dshHome, plan, options)` carry new signatures and `preflight` gained an optional second parameter; `projectionCacheLegacyDir` was renamed to `projectionCacheDir` and the module-level `cleanProjectionCacheLegacy` to `cleanProjectionCache`; `encodeSegment`, `expandHomePath`, `normalizeDshHome`, `inspectSessionsRoot`, `DSH_HOME_ENV` and the `PreflightOptions`, `PreflightResult`, `SessionsRootInspection` and `SessionsRootStatus` types are new exports.

## 1.0.0

- 首次发布:清理 DSH(DeepSeek Harness)已归档会话,删除会话目录并同步归档名单与工作区槽位。
- 默认仅预览,`--apply` 才真正修改;删除前有确认提示,非交互环境默认拒绝。
- 支持 `--backup` 备份模式、`--min-age` 活跃守卫、`--include-recent`、`--no-config`、`--home` 与中英双语提示。
- 安全机制:符号链接逃逸防护、瞬时占用重试、配置原子写入、备份目录落点校验、会话 id 格式校验、不可读会话按可能活跃跳过。
- First release: remove archived DSH session directories and sync the archive list and workspace slots, with preview-by-default, confirmation, backup mode, an activity guard, bilingual messages, and layered safety checks.
