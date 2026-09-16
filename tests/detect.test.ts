import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWindowsProbeArgs, hasForeignPid } from '../src/detect.ts'

describe('hasForeignPid', () => {
  test('排除自身与父进程后仍有命中时返回 true', () => {
    assert.equal(hasForeignPid('101\n202\n303', 202, 101), true)
  })

  test('命中全部来自自身与父进程时返回 false', () => {
    assert.equal(hasForeignPid('101\n202', 202, 101), false)
    assert.equal(hasForeignPid('202', 202, undefined), false)
  })

  test('空输出返回 false', () => {
    assert.equal(hasForeignPid('', 202, 101), false)
    assert.equal(hasForeignPid('\n', 202, 101), false)
  })
})

describe('buildWindowsProbeArgs', () => {
  test('过滤条件排除自身进程与父进程', () => {
    const args = buildWindowsProbeArgs(202, 101)
    const script = args[args.length - 1] ?? ''
    assert.match(script, /ProcessId <> 202/)
    assert.match(script, /ParentProcessId <> 101/)
    assert.match(script, /CommandLine -match 'dsh'/)
  })

  test('父进程未知时过滤条件只排除自身进程', () => {
    const args = buildWindowsProbeArgs(202, undefined)
    const script = args[args.length - 1] ?? ''
    assert.match(script, /ProcessId <> 202/)
    assert.doesNotMatch(script, /ParentProcessId/)
  })
})
