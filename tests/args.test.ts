import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/cli.ts'
import { UsageError } from '../src/errors.ts'

describe('parseArgs', () => {
  test('默认值为预览模式与 30 分钟活跃守卫', () => {
    const options = parseArgs([])
    assert.equal(options.apply, false)
    assert.equal(options.yes, false)
    assert.equal(options.minAgeMinutes, 30)
    assert.equal(options.includeRecent, false)
    assert.equal(options.updateConfig, true)
    assert.equal(options.lang, 'auto')
  })

  test('布尔参数逐一生效', () => {
    const options = parseArgs(['--apply', '--yes', '--include-recent', '--no-config', '--help', '--version'])
    assert.equal(options.apply, true)
    assert.equal(options.yes, true)
    assert.equal(options.includeRecent, true)
    assert.equal(options.updateConfig, false)
    assert.equal(options.help, true)
    assert.equal(options.version, true)
  })

  test('值参数同时支持空格与等号两种写法', () => {
    assert.equal(parseArgs(['--min-age', '5']).minAgeMinutes, 5)
    assert.equal(parseArgs(['--min-age=10']).minAgeMinutes, 10)
    assert.equal(parseArgs(['--backup', 'D:\\trash']).backupDir, 'D:\\trash')
    assert.equal(parseArgs(['--backup=D:\\trash']).backupDir, 'D:\\trash')
    assert.equal(parseArgs(['--home', 'C:\\dsh']).dshHome, 'C:\\dsh')
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
  })

  test('未知参数抛出参数错误', () => {
    assert.throws(() => parseArgs(['--nope']), UsageError)
  })

  test('非法语言抛出参数错误', () => {
    assert.throws(() => parseArgs(['--lang', 'fr']), UsageError)
  })
})
