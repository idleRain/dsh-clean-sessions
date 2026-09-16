# 贡献指南 / Contributing

## 环境要求 / Requirements

- Node.js >= 22.18,直接运行 TypeScript 源码依赖 Node 原生类型剥离 /
  needed to run the TypeScript source directly via native type stripping

## 本地开发 / Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test,直接运行 TS 源码 / runs on the TS source directly
npm run build       # tsdown 打包 dist/(cli.js + index.js + .d.ts)
npm run dev         # 从源码直接运行 CLI / run the CLI from source
```

## 代码结构 / Code layout

- `src/cli.ts` — 命令行入口:参数解析、预览、执行与退出码 / CLI entry: args parsing, preview, apply and exit codes
- `src/plan.ts` — 清理计划构建 / cleanup plan building
- `src/apply.ts` — 执行编排 / apply orchestration
- `src/fsutils.ts` — 文件系统操作与安全防护 / filesystem operations and safety guards
- `src/config.ts` — workspace.json 读取、校验与同步 / config read, validate and sync
- `src/i18n.ts` `src/locale.ts` — 中英双语消息与语言检测 / bilingual messages and language detection
- `tests/` — node:test 单元测试与端到端用例 / unit and e2e tests

## 约定 / Conventions

- 新增消息键必须同时补充中英两种语言,键名由 `MessageKey` 类型约束 /
  new message keys must be added in both languages, constrained by the `MessageKey` type
- 涉及删除路径的逻辑必须保持符号链接逃逸防护与备份目录校验 /
  deletion paths must keep the symlink escape guard and the backup dir validation
- 公开 API 与导出函数签名处需要文档注释 / exported signatures carry doc comments

## CI 与发布 / CI and release

- GitHub Actions 在 ubuntu、windows、macOS × Node 22/24 上运行 typecheck、test、build。
- 发布由 `prepublishOnly` 自动执行 typecheck + test + build 后打包 /
  publishing runs typecheck + test + build automatically via `prepublishOnly`。
- 发布前必须升版本(`npm version patch|minor|major`),npm 不允许重新发布同一版本 /
  bump the version before publishing; npm never allows re-publishing the same version。
