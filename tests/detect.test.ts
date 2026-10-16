import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPosixProbeArgs,
  buildWindowsProbeArgs,
  hasForeignDshHost,
  hasForeignPid,
  isExternalDshHost,
  parseProcessRecords,
} from '../src/detect.ts'
import type { ProcessRecord } from '../src/detect.ts'

/** 构造 Windows 探测输出的单条记录,命令行传入空串时只依赖映像名判定。 */
function makeRecord(pid: number, name: string, commandLine: string): ProcessRecord {
  return { pid, name, commandLine }
}

/** 按探测输出格式拼接一行记录,用于覆盖解析与判定的组合路径。 */
function makeProbeLine(pid: number, name: string, commandLine: string): string {
  return `${pid}\t${name}\t${commandLine}`
}

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

  test('粗筛条件同时覆盖 node.exe 命令行与 desktop 映像名', () => {
    const args = buildWindowsProbeArgs(202, 101)
    const script = args[args.length - 1] ?? ''
    assert.match(script, /Name -match 'deepseek harness'/)
    assert.match(script, /Name -match 'dsh-desktop'/)
  })

  test('输出制表符分隔的进程记录供纯函数判定', () => {
    const args = buildWindowsProbeArgs(202, 101)
    const script = args[args.length - 1] ?? ''
    assert.match(script, /ProcessId, \$_.Name, \$_.CommandLine/)
    assert.match(script, /-join \[char\]9/)
  })
})

describe('parseProcessRecords', () => {
  test('解析制表符分隔的记录并兼容 CRLF 行尾', () => {
    const output = `${makeProbeLine(700, 'DeepSeek Harness.exe', 'C:\\App\\DeepSeek Harness.exe')}\r\n${makeProbeLine(800, 'node.exe', 'node dsh.js')}`
    const records = parseProcessRecords(output)
    assert.deepEqual(records, [
      { pid: 700, name: 'DeepSeek Harness.exe', commandLine: 'C:\\App\\DeepSeek Harness.exe' },
      { pid: 800, name: 'node.exe', commandLine: 'node dsh.js' },
    ])
  })

  test('跳过字段不足与 pid 非法的行', () => {
    assert.deepEqual(parseProcessRecords('no-separator\nabc\tnode.exe\tdsh\n'), [])
  })

  test('命令行内部的制表符保留在命令行字段', () => {
    const records = parseProcessRecords(makeProbeLine(700, 'node.exe', 'node\tdsh.js'))
    assert.equal(records[0]?.commandLine, 'node\tdsh.js')
  })

  test('空输出返回空列表', () => {
    assert.deepEqual(parseProcessRecords(''), [])
  })
})

describe('isExternalDshHost', () => {
  test('desktop 应用可执行文件命中', () => {
    const desktop = makeRecord(
      700,
      'DeepSeek Harness.exe',
      '"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals',
    )
    assert.equal(isExternalDshHost(desktop, 202, 101), true)
  })

  test('desktop 候选命名与大小写差异命中', () => {
    assert.equal(isExternalDshHost(makeRecord(700, 'deepseek harness.exe', ''), 202, 101), true)
    assert.equal(isExternalDshHost(makeRecord(701, 'dsh-desktop.exe', ''), 202, 101), true)
  })

  test('node.exe 且命令行含 dsh 命中', () => {
    const cli = makeRecord(700, 'node.exe', 'node C:\\npm\\node_modules\\dsh\\bin\\dsh.js --home C:\\Users\\me\\.dsh')
    assert.equal(isExternalDshHost(cli, 202, 101), true)
  })

  test('开发模式的 electron.exe 由宿主入口路径命中', () => {
    const development = makeRecord(700, 'electron.exe', 'electron.exe E:\\repo\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js')
    assert.equal(isExternalDshHost(development, 202, 101), true)
  })

  test('无关进程不命中', () => {
    assert.equal(isExternalDshHost(makeRecord(700, 'node.exe', 'node C:\\work\\server.js'), 202, 101), false)
    assert.equal(isExternalDshHost(makeRecord(701, 'notepad.exe', 'notepad.exe C:\\notes.txt'), 202, 101), false)
    assert.equal(isExternalDshHost(makeRecord(702, 'chrome.exe', 'chrome.exe --type=renderer'), 202, 101), false)
  })

  test('自身 pid 与父 pid 被排除', () => {
    const selfLine = 'node C:\\npm\\node_modules\\dsh-clean-sessions\\src\\cli.ts'
    assert.equal(isExternalDshHost(makeRecord(202, 'node.exe', selfLine), 202, 101), false)
    assert.equal(isExternalDshHost(makeRecord(101, 'node.exe', selfLine), 202, 101), false)
  })

  test('父 pid 未知时只排除自身进程', () => {
    assert.equal(isExternalDshHost(makeRecord(101, 'DeepSeek Harness.exe', ''), 202, undefined), true)
  })

  test('Windows 反斜杠路径与大小写差异不造成漏判', () => {
    const host = makeRecord(700, 'NODE.EXE', 'C:\\Tools\\DSH\\bin\\dsh.js --home D:\\DSH_HOME')
    assert.equal(isExternalDshHost(host, 202, 101), true)
  })
})

describe('hasForeignDshHost', () => {
  test('输出含 desktop 宿主记录时命中', () => {
    const output = `${makeProbeLine(700, 'DeepSeek Harness.exe', 'C:\\App\\DeepSeek Harness.exe')}\n`
    assert.equal(hasForeignDshHost(output, 202, 101), true)
  })

  test('命中全部来自自身与父进程时返回 false', () => {
    const output = `${makeProbeLine(202, 'node.exe', 'node dsh-clean-sessions')}\n${makeProbeLine(101, 'node.exe', 'npx dsh-clean-sessions')}`
    assert.equal(hasForeignDshHost(output, 202, 101), false)
  })

  test('空输出不命中', () => {
    assert.equal(hasForeignDshHost('', 202, 101), false)
  })
})

describe('POSIX 探测', () => {
  // 判定模式与 pgrep 同为扩展正则,用 RegExp 复用同一模式字符串验证覆盖范围,无需真的枚举进程。
  const pattern = buildPosixProbeArgs()[1] ?? ''

  test('以 -f 匹配完整命令行', () => {
    assert.equal(buildPosixProbeArgs()[0], '-f')
  })

  test('含 dsh 的命令行命中', () => {
    const cli = '/usr/bin/node /usr/lib/node_modules/dsh/bin/dsh.js --home /home/me/.dsh'
    assert.equal(new RegExp(pattern).test(cli), true)
  })

  test('desktop 应用路径命中', () => {
    const desktop = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals'
    assert.equal(new RegExp(pattern).test(desktop), true)
  })

  test('大小写差异不造成漏判', () => {
    assert.equal(new RegExp(pattern).test('/opt/DSH/bin/dsh'), true)
    assert.equal(new RegExp(pattern).test('/opt/DeepSeek Harness/dsh-desktop'), true)
  })

  test('无关命令行不命中', () => {
    assert.equal(new RegExp(pattern).test('/usr/bin/node /srv/app/server.js'), false)
  })

  test('空输出不命中', () => {
    assert.equal(new RegExp(pattern).test(''), false)
  })

  test('自身与父 pid 被排除', () => {
    assert.equal(hasForeignPid('202\n101', 202, 101), false)
  })
})
