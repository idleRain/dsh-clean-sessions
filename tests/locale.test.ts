import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHostLanguage } from '../src/locale.ts'
import { resolveLanguage } from '../src/i18n.ts'

describe('detectHostLanguage', () => {
  test('区域环境变量命中中文返回 zh', () => {
    assert.equal(detectHostLanguage({ env: { LANG: 'zh_CN.UTF-8' }, platform: 'linux' }), 'zh')
    assert.equal(detectHostLanguage({ env: { LC_ALL: 'zh_TW.UTF-8' }, platform: 'linux' }), 'zh')
  })

  test('非中文区域环境返回 en', () => {
    assert.equal(detectHostLanguage({ env: { LANG: 'en_US.UTF-8' }, platform: 'linux', intlLocale: 'en-US' }), 'en')
    assert.equal(detectHostLanguage({ env: { LANG: 'fr_FR.UTF-8' }, platform: 'linux', intlLocale: 'fr-FR' }), 'en')
  })

  test('Windows UI 语言命中中文返回 zh,简繁一致', () => {
    assert.equal(detectHostLanguage({ env: {}, platform: 'win32', uiCulture: 'zh-CN', intlLocale: 'en-US' }), 'zh')
    assert.equal(detectHostLanguage({ env: {}, platform: 'win32', uiCulture: 'zh-Hant-TW', intlLocale: 'en-US' }), 'zh')
  })

  test('Windows 非中文 UI 语言返回 en', () => {
    assert.equal(detectHostLanguage({ env: {}, platform: 'win32', uiCulture: 'en-US', intlLocale: 'en-US' }), 'en')
  })

  test('Intl 默认区域命中中文返回 zh', () => {
    assert.equal(detectHostLanguage({ env: {}, platform: 'linux', uiCulture: null, intlLocale: 'zh-CN' }), 'zh')
  })

  test('全部输入均非中文时返回 en', () => {
    assert.equal(detectHostLanguage({ env: {}, platform: 'linux', uiCulture: null, intlLocale: 'en-US' }), 'en')
  })
})

describe('resolveLanguage', () => {
  test('显式语言优先于一切', () => {
    assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }), 'en')
  })

  test('环境变量覆盖优先于主机检测', () => {
    assert.equal(resolveLanguage(undefined, { CLEAN_SESSIONS_LANG: 'en', LANG: 'zh_CN.UTF-8' }), 'en')
  })

  test('未显式指定时按主机语言检测', () => {
    assert.equal(resolveLanguage(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh')
  })
})
