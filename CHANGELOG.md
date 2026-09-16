# Changelog

All notable changes to this project are documented in this file.

## 1.0.0

- 首次发布:清理 DSH(DeepSeek Harness)已归档会话,删除会话目录并同步归档名单与工作区槽位。
- 默认仅预览,`--apply` 才真正修改;删除前有确认提示,非交互环境默认拒绝。
- 支持 `--backup` 备份模式、`--min-age` 活跃守卫、`--include-recent`、`--no-config`、`--home` 与中英双语提示。
- 安全机制:符号链接逃逸防护、瞬时占用重试、配置原子写入、备份目录落点校验、会话 id 格式校验、不可读会话按可能活跃跳过。
- First release: remove archived DSH session directories and sync the archive list and workspace slots, with preview-by-default, confirmation, backup mode, an activity guard, bilingual messages, and layered safety checks.
