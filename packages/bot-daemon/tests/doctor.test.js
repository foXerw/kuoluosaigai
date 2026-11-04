// @vitest-environment node
// Task 9：doctor 体检测试。网络面全部注入（fetchImpl/WebSocketImpl/load/now/sleep），
// 零真实网络；brief Step 1 的四条用例名逐字保留，另钉 R5（裸 WS 探活不留句柄、不谎报 OK）、
// Task 4 parked Minor②（kind 标签如实透传）、§5「明确结论不许耸肩」（依赖项在未实测时必须 FAIL）。
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigLoadError } from '../config.js'
import { runDoctor, WS_TIMEOUT_MS, CLOCK_THRESHOLD_MS } from '../doctor.js'

const SECRET = 'sk-SUPERSECRET-do-not-leak-9f3a'
const BASE_URL = 'https://api.deepseek.com/v1'
const SERVER_URL = 'wss://kuoluosaigai.com'
const NOW = 1730000000000

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-doctor-test-'))
})
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

function validRaw(over) {
  return Object.assign(
    {
      name: 'lab-vm',
      serverUrl: SERVER_URL,
      provider: { baseUrl: BASE_URL, apiKey: SECRET, model: 'deepseek-chat' },
      bots: [{ id: 'lixiao', name: '小李', persona: '话少', room: 'nebula' }],
    },
    over || {},
  )
}

// —— 注入件 ——

function okChatResponse() {
  return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }
}

function httpStatusResponse(status) {
  return { status, ok: false, json: async () => ({}) }
}

function headResponse(dateHeader) {
  return { status: 200, ok: true, headers: { get: (k) => (String(k).toLowerCase() === 'date' ? dateHeader : null) } }
}

// fetch 间谍：chat POST 走 chatResponder，时钟 HEAD 走 dateHeader。
function makeFetch(opts) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url, method, headers: init && init.headers })
    if (method === 'HEAD') return headResponse(opts.dateHeader === undefined ? new Date(NOW).toUTCString() : opts.dateHeader)
    if (opts.chatThrow) throw opts.chatThrow
    return opts.chatResponder ? opts.chatResponder() : okChatResponse()
  }
  return { fetchImpl, calls }
}

// 裸 WebSocket 替身（R5：doctor 的可达性判据只看握手，不看协议帧）。
function makeWebSocket(behavior) {
  const instances = []
  const WebSocketImpl = function FakeWS(url) {
    const self = {
      url,
      closed: false,
      _h: {},
      addEventListener(type, cb) {
        (self._h[type] = self._h[type] || []).push(cb)
      },
      removeEventListener(type, cb) {
        self._h[type] = (self._h[type] || []).filter((f) => f !== cb)
      },
      close() {
        self.closed = true
      },
      _fire(type, ev) {
        (self._h[type] || []).slice().forEach((cb) => cb(ev || {}))
      },
    }
    instances.push(self)
    if (behavior === 'sync-throw') throw new Error('构造禁止')
    setTimeout(() => {
      if (behavior === 'open') self._fire('open')
      else if (behavior === 'error') self._fire('error')
      else if (behavior === 'close') self._fire('close', { code: 1006 })
      // 'silent'：永不回事件 → 走超时路径
    }, 0)
    return self
  }
  return { WebSocketImpl, instances }
}

function baseOver(over) {
  const dir = (over && over.dataDir) || freshDir()
  const lines = []
  const print = (l) => lines.push(l)
  const load =
    over && over.load
      ? over.load
      : async () => {
          if (over && over.loadThrow) throw over.loadThrow
          return (over && over.raw) || validRaw()
        }
  const ws = makeWebSocket((over && over.wsBehavior) || 'open')
  const ft = makeFetch(over || {})
  const options = Object.assign(
    {
      configPath: 'injected-never-read.js',
      dataDir: dir,
      print,
      load,
      fetchImpl: ft.fetchImpl,
      WebSocketImpl: ws.WebSocketImpl,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      nodeVersion: over && over.nodeVersion !== undefined ? over.nodeVersion : '24.16.0',
      hasNativeWebSocket: !(over && over.wsPresent === false),
    },
    (over && over.options) || {},
  )
  return { options, lines, dir, ws, ft }
}

function joined(lines) {
  return lines.join('\n')
}

function lineFor(lines, needle) {
  return lines.find((l) => l.indexOf(needle) !== -1)
}

// —— brief Step 1 的四条（用例名逐字保留）——

it('provider 401 → 该项 FAIL 且 detail 不含 key（B9 同源）', async () => {
  const { options, lines } = baseOver({ chatResponder: () => httpStatusResponse(401) })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  const line = lineFor(lines, 'provider 连通性')
  expect(line).toBeDefined()
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain('鉴权')
  expect(joined(lines)).not.toContain(SECRET)
})

it('provider 429 → FAIL 但文案区分于 auth（运维要能分辨"没配额"与"key 错"）', async () => {
  const { options, lines, ft } = baseOver({ chatResponder: () => httpStatusResponse(429) })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  const line = lineFor(lines, 'provider 连通性')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain('限流')
  expect(line).toContain('配额')
  expect(line).not.toContain('鉴权失败') // auth 文案的开头词，不得出现在 rate 行里
  // rate 类错误恰好重试一次（core 的重试语义），第二次仍 429 才判 FAIL
  const posts = ft.calls.filter((c) => c.method === 'POST')
  expect(posts.length).toBe(2)
  expect(joined(lines)).not.toContain(SECRET)
})

it('WebSocket 不可达 → FAIL 且给出 serverUrl，不谎报 OK', async () => {
  const { options, lines } = baseOver({ wsBehavior: 'error' })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  const line = lineFor(lines, 'serverUrl WS 可达性')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain(SERVER_URL)
})

it('全部通过 → 退出码 0；任一 FAIL → 退出码 1', async () => {
  const pass = baseOver({})
  const code0 = await runDoctor(pass.options)
  expect(code0).toBe(0)
  expect(pass.lines.filter((l) => l.startsWith('OK')).length).toBe(7)
  expect(pass.lines.filter((l) => l.startsWith('FAIL')).length).toBe(0)
  expect(joined(pass.lines)).not.toContain(SECRET)
  // §5 那条未实测前提必须给出**明确结论**（不是耸肩）：OK 文案里点名出网判据
  expect(lineFor(pass.lines, 'provider 连通性')).toContain('§5')

  const fail = baseOver({ nodeVersion: '20.11.0' })
  const code1 = await runDoctor(fail.options)
  expect(code1).toBe(1)
  expect(lineFor(fail.lines, 'Node 版本').startsWith('FAIL')).toBe(true)
  expect(lineFor(fail.lines, 'Node 版本')).toContain('22')
})

// —— 其余钉死项 ——

it('WS 探测成功后立即 close（不留活连接），且 open 前收到 close 也判 FAIL 带 code', async () => {
  const a = baseOver({ wsBehavior: 'open' })
  await runDoctor(a.options)
  expect(a.ws.instances.length).toBe(1)
  expect(a.ws.instances[0].closed).toBe(true)

  const b = baseOver({ wsBehavior: 'close' })
  const code = await runDoctor(b.options)
  expect(code).toBe(1)
  const line = lineFor(b.lines, 'serverUrl WS 可达性')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain('1006')
})

it('配置读取失败 → ConfigLoadError 的 kind 如实透传（Task 4 parked Minor②：不继承错标签）', async () => {
  const { options, lines } = baseOver({ loadThrow: new ConfigLoadError('unparsable', 'x.js', '半写坏语法') })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  expect(lineFor(lines, '配置校验')).toContain('unparsable')
})

it('配置非法 → provider/WS/时钟三项 FAIL「未实测」，绝不给它们印 OK', async () => {
  const bad = validRaw()
  bad.bots = 'not-an-array' // bots: [] 是合法的「零 bot」指令（watch.js 文件头），要真非法才走到「未实测」分支
  const { options, lines } = baseOver({ raw: bad })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  expect(lineFor(lines, '配置校验').startsWith('FAIL')).toBe(true)
  expect(joined(lines)).toContain('bots: 必须是数组') // 真实 validateConfig 逐行错误在场
  for (const key of ['provider 连通性', 'serverUrl WS 可达性', '本地时钟']) {
    const line = lineFor(lines, key)
    expect(line.startsWith('FAIL')).toBe(true)
    expect(line).toContain('未实测')
  }
  // 不依赖配置的两项照常跑：数据目录可写（tmpdir）应 OK
  expect(lineFor(lines, '数据目录').startsWith('OK')).toBe(true)
})

it('时钟偏移超阈值 → FAIL 且报出偏移秒数与 NTP 指引；缺 Date 头 → FAIL 不装认证过', async () => {
  const drift = baseOver({ dateHeader: new Date(NOW - 3600 * 1000).toUTCString() })
  const code = await runDoctor(drift.options)
  expect(code).toBe(1)
  const line = lineFor(drift.lines, '本地时钟')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain('3600')
  expect(line).toContain('NTP')
  expect(line).toContain(String(Math.round(CLOCK_THRESHOLD_MS / 1000)))

  const noDate = baseOver({ dateHeader: null })
  const code2 = await runDoctor(noDate.options)
  expect(code2).toBe(1)
  expect(lineFor(noDate.lines, '本地时钟').startsWith('FAIL')).toBe(true)
})

it('时钟检查走 provider 的 HTTP Date 头（HEAD 请求、读不到基准判 FAIL）', async () => {
  const { options, ft } = baseOver({})
  await runDoctor(options)
  const heads = ft.calls.filter((c) => c.method === 'HEAD')
  expect(heads.length).toBe(1)
  expect(heads[0].url).toBe(BASE_URL)
  const posts = ft.calls.filter((c) => c.method === 'POST')
  expect(posts[0].url).toBe(BASE_URL + '/chat/completions')
  expect(posts[0].headers.Authorization).toBe('Bearer ' + SECRET) // 只入请求头，绝不出现在任何打印行
})

it('数据目录不可写 → 该项 FAIL（路径在内，退 1）', async () => {
  const dir = freshDir()
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  const { options, lines } = baseOver({ dataDir: path.join(blocker, 'sub') })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  const line = lineFor(lines, '数据目录')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain(path.join('blocker', 'sub'))
})

it('原生 WebSocket 缺失 → FAIL（R5/D1 前提：没有全局 WS 就没有 P1 的连接形态）', async () => {
  const { options, lines } = baseOver({ wsPresent: false })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  expect(lineFor(lines, '原生 WebSocket').startsWith('FAIL')).toBe(true)
})

it('WS 握手超时 → FAIL，且探测不留悬挂定时器（句柄纪律，Task 8 同款）', async () => {
  vi.useFakeTimers()
  try {
    const { options, lines, ws } = baseOver({ wsBehavior: 'silent' }) // 用导出的缺省 WS_TIMEOUT_MS 本体
    const p = runDoctor(options)
    await vi.advanceTimersByTimeAsync(WS_TIMEOUT_MS + 5)
    const code = await p
    expect(code).toBe(1)
    const line = lineFor(lines, 'serverUrl WS 可达性')
    expect(line.startsWith('FAIL')).toBe(true)
    expect(line).toContain('超时')
    expect(vi.getTimerCount()).toBe(0)
    // Important 1：CONNECTING 状态的套接字本身是 ref 句柄（黑洞 TCP 在 Node 24 实测悬挂进程）——
    // 超时/失败路径也必须 best-effort close。文件头「不留悬挂句柄」的声明由这条 +
    // cli.test 的 spawn blackhole 用例联合兑现。
    expect(ws.instances.length).toBe(1)
    expect(ws.instances[0].closed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('error 路径同样关套接字（Important 1：失败路径 close 是卫生，不是可选）', async () => {
  const { options, ws } = baseOver({ wsBehavior: 'error' })
  await runDoctor(options)
  expect(ws.instances[0].closed).toBe(true)
})

it('check 自身逃逸异常 → FAIL 带原因而不是 undefined（Important 3；覆盖非 ConfigLoadError 重抛分支）', async () => {
  const boom = new TypeError('boom-internal')
  const { options, lines } = baseOver({ load: async () => { throw boom } })
  const code = await runDoctor(options)
  expect(code).toBe(1)
  const line = lineFor(lines, '配置校验')
  expect(line.startsWith('FAIL')).toBe(true)
  expect(line).toContain('TypeError')
  expect(joined(lines)).not.toContain('undefined')
})
