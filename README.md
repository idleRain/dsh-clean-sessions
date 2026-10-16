# dsh-clean-sessions

零第三方运行时依赖的命令行工具,用于清理
[DSH(DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 的已归档会话:
删除归档名单中的会话日志目录,并同步归档名单与工作区槽位,不留幽灵条目与死槽位。

已在 DSH `0.1.5-rc.1` 至 `0.2.1-alpha.4` 上验证,覆盖 V4 会话日志、per-record 投影缓存与 workspace 域 v2。

[English](#english) · 开发与发布见 [CONTRIBUTING.md](https://github.com/idleRain/dsh-clean-sessions/blob/master/CONTRIBUTING.md)

## 为什么需要它

DSH 的"归档"只是 `<dshHome>/storages/workspace.json` 中 `global.archivedSessionIds`
里的一个 id,而会话日志位于 `<dshHome>/sessions/<项目分组>/<会话id>/`。安全删除必须
同时移除磁盘目录并从配置中摘除 id,而 DSH 持久层没有删除接口,GUI 也只提供归档与
取消归档,本工具补齐这一空缺。

## 安装

需要 Node.js >= 22.18。

```bash
npm install -g dsh-clean-sessions
# 或免安装直接运行
npx dsh-clean-sessions --help
```

## 使用

```bash
dsh-clean-sessions                  # 预览,不修改任何文件
dsh-clean-sessions --apply --yes    # 真正执行删除并同步配置
```

### 选项

| 选项 | 说明 |
|---|---|
| `--apply` | 真正执行删除与配置更新,默认只输出预览 |
| `--yes` | 跳过删除前的确认提示,仅配合 `--apply` 使用 |
| `--min-age <分钟>` | 最近多少分钟内有写入的归档会话视为可能活跃,默认 `30`,设为 `0` 关闭守卫 |
| `--include-recent` | 强制纳入最近有写入的归档会话,默认排除 |
| `--backup <目录>` | 把会话目录移入备份目录而非直接删除,不能位于 DSH 主目录之内 |
| `--no-config` | 只删除磁盘目录,不同步 `workspace.json` 配置 |
| `--allow-missing-sessions` | 会话根目录缺失或不可用时仍继续执行,此时候选会话无法核实,`workspace.json` 保持不变 |
| `--home <目录>` | 指定 DSH 主目录,默认读取 `$DSH_HOME` 或 `~/.dsh` |
| `--lang <zh\|en>` | 提示语言,默认检测主机语言 |
| `--version` / `--help` | 输出版本号 / 显示帮助 |

### 示例

```bash
dsh-clean-sessions --apply --backup "D:\dsh-trash\2026-09-16"   # 先备份再删除
dsh-clean-sessions --home "D:\data\dsh"                         # 指定自定义 DSH 主目录
```

## 安全说明

1. 默认仅预览,必须显式传入 `--apply` 才会修改文件;删除前有确认提示,非交互环境默认拒绝。
2. 只处理归档名单内的会话;最近写入的会话默认跳过,无法读取的会话目录按可能活跃处理。
3. 位于 sessions 根目录之外的目录疑似符号链接逃逸,只列出并跳过,不会删除。
4. `--backup` 备份目录不能位于 DSH 主目录之内,工具会在删除任何文件前拒绝。
5. 若 dsh 正在运行,改完配置必须重启 dsh,否则内存中的旧名单会被写回并产生幽灵条目。
6. 附件存储不会被清理。`<dshHome>/storages/session_projcache/sessions/` 下的 per-record 布局是 DSH 当前布局,工具会清理其中已消失会话的 `<id>.json` 文档;同级的 `session_projcache.json` 单文件是 pre-per-record 的历史遗留,不会被触碰。
7. 会话目录缺失或不可读时,工具在修改任何文件之前以退出码 `1` 终止;只有显式传入 `--allow-missing-sessions` 才继续执行,此时候选会话无法核实,`workspace.json` 保持不变。
8. DSH desktop 与 web 共用同一个主目录,操作前需退出正在运行的 desktop 应用与/或 web 宿主,包括其它 profile 的宿主进程,否则内存中的旧名单会被写回。
9. sessions 根的位置取决于 `$DSH_HOME` 指向的主目录,也可以被 profile 的 `cordis.patch.yml` 或 `--patch` 改到别处;工具无法感知这类 patch 覆盖,只会报"会话目录不存在"或"会话目录不可用",此时应先核对 patch 层,而不是把名单内的会话当作幽灵条目。

## 许可证

[MIT](https://github.com/idleRain/dsh-clean-sessions/blob/master/LICENSE)

---

# English

A zero-runtime-dependency CLI to clean up archived sessions of
[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness):
it removes the session log directories listed in the archive and syncs the
archive list and workspace slots, leaving no ghost entries behind.

Verified against DSH `0.1.5-rc.1` through `0.2.1-alpha.4`, covering V4 session
logs, the per-record projection cache and workspace domain v2.

Development and release notes: [CONTRIBUTING.md](https://github.com/idleRain/dsh-clean-sessions/blob/master/CONTRIBUTING.md) · [中文文档见上](#dsh-clean-sessions)

## Why this exists

An archived DSH session is only an id in `global.archivedSessionIds` inside
`<dshHome>/storages/workspace.json`, while session logs live in
`<dshHome>/sessions/<project-group>/<session-id>/`. Safe deletion means removing
the directories and dropping the ids from the config; DSH has no deletion API
and the GUI only offers archive/unarchive, so this tool fills the gap.

## Install

Requires Node.js >= 22.18.

```bash
npm install -g dsh-clean-sessions
# or run without installing
npx dsh-clean-sessions --help
```

## Usage

```bash
dsh-clean-sessions                  # preview, changes nothing
dsh-clean-sessions --apply --yes    # delete and sync the config
```

### Options

| Option | Description |
|---|---|
| `--apply` | Actually delete and update the config; preview by default |
| `--yes` | Skip the confirmation prompt; only with `--apply` |
| `--min-age <minutes>` | Treat sessions written within this many minutes as potentially active; default `30`, `0` disables the guard |
| `--include-recent` | Force-include recently written sessions (skipped by default) |
| `--backup <dir>` | Move session directories into a backup dir instead of deleting; must be outside the DSH home |
| `--no-config` | Only remove on-disk directories, skip the `workspace.json` sync |
| `--allow-missing-sessions` | Continue when the sessions root is missing or unusable; candidates cannot be verified and the config stays unchanged |
| `--home <dir>` | DSH home directory; defaults to `$DSH_HOME` or `~/.dsh` |
| `--lang <zh\|en>` | Message language; auto-detected by default |
| `--version` / `--help` | Print version / show help |

### Examples

```bash
dsh-clean-sessions --apply --backup "D:\dsh-trash\2026-09-16"   # back up before deleting
dsh-clean-sessions --home "D:\data\dsh"                          # custom DSH home
```

## Safety notes

1. Preview only by default; `--apply` is required to change anything. A
   confirmation prompt guards destructive runs, and non-interactive stdin
   defaults to no.
2. Only archived sessions are touched; recently written ones are skipped by
   default, and unreadable session directories are treated as potentially
   active.
3. Directories resolving outside the sessions root (symlink or junction
   escapes) are listed and skipped, never deleted.
4. `--backup` must be outside the DSH home; the tool rejects such paths before
   deleting anything.
5. If dsh is running, restart it after the config change, otherwise the
   in-memory archive list is written back and ghost entries reappear.
6. The attachment store is never touched. The per-record layout under
   `<dshHome>/storages/session_projcache/sessions/` is the current DSH layout and
   the tool removes the `<id>.json` documents of sessions that are gone; the
   sibling single-file `session_projcache.json` is pre-per-record legacy and is
   left alone.
7. When the sessions directory is missing or unreadable the tool exits with code
   `1` before modifying any file; only an explicit
   `--allow-missing-sessions` continues, and in that case candidates cannot be
   verified and `workspace.json` stays unchanged.
8. The DSH desktop app and the web host share the same home directory; quit the
   running desktop app and/or web hosts, including host processes of other
   profiles, before running the tool, otherwise the in-memory archive list is
   written back.
9. The sessions root follows the home directory selected by `$DSH_HOME` and can
   also be relocated by the profile `cordis.patch.yml` or `--patch`; the tool
   cannot see such patch overrides and only reports that the sessions directory is
   missing or unusable, so check the patch layer instead of treating the listed
   sessions as ghost entries.

## License

[MIT](https://github.com/idleRain/dsh-clean-sessions/blob/master/LICENSE)
