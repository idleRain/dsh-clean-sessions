/**
 * tsdown 构建配置:CLI 与程序化 API 各自独立打包为自包含单文件,
 * 避免共享模块被代码分割出公共 chunk,产物统一使用 .js 扩展名。
 * cli.ts 的 shebang 会被保留并自动授予执行权限,可直接作为 npm bin 使用。
 * @see https://tsdown.dev
 */

import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: 'src/cli.ts',
    format: 'esm',
    target: 'node22',
    dts: true,
    clean: true,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: 'src/index.ts',
    format: 'esm',
    target: 'node22',
    dts: true,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
  },
])
