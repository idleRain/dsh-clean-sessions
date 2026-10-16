import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from '../src/cli.ts'
import { UsageError } from '../src/errors.ts'
import { expandHomePath, normalizeDshHome, resolveDshHome } from '../src/paths.ts'

describe('parseArgs', () => {
  test('默认值为预览模式与 30 分钟活跃守卫', () => {
    const options = parseArgs([])
    assert.equal(options.apply, false)
    assert.equal(options.minAgeMinutes, 30)
    assert.equal(options.includeRecent, false)
    assert.equal(options.keepChildren, false)
    assert.equal(options.keepAttachments, false)
    assert.equal(options.updateConfig, true)
    assert.equal(options.allowMissingSessions, false)
    assert.equal(options.lang, 'auto')
  })

  test('布尔参数逐一生效', () => {
    const options = parseArgs(['--apply', '--include-recent', '--keep-children', '--keep-attachments', '--no-config', '--allow-missing-sessions', '--help', '--version'])
    assert.equal(options.apply, true)
    assert.equal(options.includeRecent, true)
    assert.equal(options.keepChildren, true)
    assert.equal(options.keepAttachments, true)
    assert.equal(options.updateConfig, false)
    assert.equal(options.allowMissingSessions, true)
    assert.equal(options.help, true)
    assert.equal(options.version, true)
  })

  test('值参数同时支持空格与等号两种写法', () => {
    assert.equal(parseArgs(['--min-age', '5']).minAgeMinutes, 5)
    assert.equal(parseArgs(['--min-age=10']).minAgeMinutes, 10)
    assert.equal(parseArgs(['--backup', 'D:\\trash']).backupDir, 'D:\\trash')
    assert.equal(parseArgs(['--backup=D:\\trash']).backupDir, 'D:\\trash')
    assert.equal(parseArgs(['--home', '/tmp/dsh']).dshHome, normalizeDshHome('/tmp/dsh'))
    assert.equal(parseArgs(['--home=/tmp/dsh']).dshHome, normalizeDshHome('/tmp/dsh'))
    assert.equal(parseArgs(['--lang', 'en']).lang, 'en')
    assert.equal(parseArgs(['--lang=zh']).lang, 'zh')
  })

  test('非法 min-age 抛出参数错误', () => {
    assert.throws(() => parseArgs(['--min-age', '-1']), UsageError)
    assert.throws(() => parseArgs(['--min-age', 'abc']), UsageError)
  })

  test('空路径参数抛出参数错误', () => {
    assert.throws(() => parseArgs(['--backup', '']), UsageError)
    assert.throws(() => parseArgs(['--backup=']), UsageError)
  })

  test('布尔参数带内联值抛出参数错误', () => {
    assert.throws(() => parseArgs(['--apply=yes']), UsageError)
    assert.throws(() => parseArgs(['--keep-children=1']), UsageError)
    assert.throws(() => parseArgs(['--keep-attachments=1']), UsageError)
  })

  test('未知参数抛出参数错误', () => {
    assert.throws(() => parseArgs(['--nope']), UsageError)
  })

  test('非法语言抛出参数错误', () => {
    assert.throws(() => parseArgs(['--lang', 'fr']), UsageError)
  })

  test('--home 传入的波浪号路径同样被展开与绝对化', () => {
    assert.equal(parseArgs(['--home', '~/dsh-data']).dshHome, resolve(join(homedir(), 'dsh-data')))
    assert.equal(parseArgs(['--home=~\\dsh-data']).dshHome, resolve(join(homedir(), 'dsh-data')))
  })
})

describe('DSH 主目录解析', () => {
  test('波浪号前缀按 DSH 语义展开,~other 形式不展开', () => {
    assert.equal(expandHomePath('~'), homedir())
    assert.equal(expandHomePath('~/x'), join(homedir(), 'x'))
    assert.equal(expandHomePath('~\\x'), join(homedir(), 'x'))
    assert.equal(expandHomePath('~other/x'), '~other/x')
    assert.equal(expandHomePath('relative/x'), 'relative/x')
  })

  test('显式路径优先于环境变量,空白环境变量视为未设置', () => {
    assert.equal(resolveDshHome('~/explicit', { DSH_HOME: join(homedir(), 'env') }), resolve(join(homedir(), 'explicit')))
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '   ' }), resolve(join(homedir(), '.dsh')))
    assert.equal(resolveDshHome(undefined, {}), resolve(join(homedir(), '.dsh')))
  })

  test('环境变量中的波浪号与相对路径同样被展开与绝对化', () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '~/env-home' }), resolve(join(homedir(), 'env-home')))
    assert.equal(resolveDshHome(undefined, { DSH_HOME: 'relative-home' }), resolve('relative-home'))
    assert.equal(isAbsolute(resolveDshHome(undefined, { DSH_HOME: 'relative-home' })), true)
  })
})
