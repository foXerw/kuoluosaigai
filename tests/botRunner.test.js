import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBotRunner } from '../src/bots/runner'
import { IDLE_KICK, MAX_TEXT } from '../src/bots/prompt'

// StubSocket：不自动 open 的 ws 替身（沿用 botConnection.test.js 模式）——runner 测试
// 需要「何时算连上」完全由测试手动 open() 控制，配合 vi.useFakeTimers 驱动退避/窗口定时器。
class StubSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closedRequested = false
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    StubSocket.instances.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  open() {
    this.readyState = 1
    if (this.onopen) this.onopen()
  }
  fail(code) {
    this.readyState = 3
    if (this.onclose) this.onclose({ code })
  }
  close() {
    this.closedRequested = true
  }
  emit(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }
}
StubSocket.instances = []

function framesOf(s) {
  return s.sent.map((d) => JSON.parse(d))
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 逐值弹出 rng：序列耗尽即抛——强制每个测试精确记账 rhythm 的每次掷骰
function mkRng(vals) {
  let i = 0
  return () => {
    if (i >= vals.length) throw new Error(`rng 序列耗尽（第 ${i + 1} 次调用）`)
    return vals[i++]
  }
}
const always = (v) => () => v

const KEY = 'sk-LEAK-9f3q'

function llmOk(content, usage = { prompt_tokens: 11, completion_tokens: 7 }) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) }
}
function httpError(status) {
  return { ok: false, status, json: async () => ({ error: 'nope' }) }
}

const msgFrame = (over = {}) => ({
  type: 'message',
  id: 'm' + Math.random().toString(36).slice(2, 7),
  ts: 100,
  roomId: 'roomA',
  nick: 'ANON-H1',
  badge: '',
  text: '今天天气不错',
  ...over,
})

function makeRunner(opts = {}) {
  const patches = []
  const events = []
  const sleepQ = []
  const bot = {
    id: 'b1', name: 'Nova', persona: '毒舌老程序员', chattiness: 50,
    model: 'test-model', temperature: 0.7, rawPrompt: '', roomId: 'roomA', nick: null,
    ...(opts.bot || {}),
  }
  const provider = { baseUrl: 'https://api.example/v1', apiKey: KEY, ...(opts.provider || {}) }
  let T = 0
  const sleep =
    opts.sleepMode === 'auto'
      ? vi.fn(async () => {})
      : vi.fn((ms) => {
          const d = deferred()
          sleepQ.push({ ms, d })
          return d.promise
        })
  const fetchImpl = opts.fetchImpl || vi.fn(async () => llmOk('你好呀，朋友'))
  const runner = createBotRunner({
    bot,
    provider,
    wsUrl: 'ws://test',
    getOwnerNick: () => opts.ownerNick || null,
    getFamilyNicks: () => new Set(opts.familyNicks || []),
    rng: opts.rng || always(0.5),
    now: () => T,
    sleep,
    WebSocketImpl: StubSocket,
    fetchImpl,
    onState: (p) => patches.push(p),
    onEvent: (t, payload) => events.push({ t, payload }),
  })
  const resolveSleep = () => {
    const s = sleepQ.shift()
    s.d.resolve()
  }
  return { runner, bot, provider, patches, events, sleepQ, resolveSleep, fetchImpl, setT: (t) => { T = t } }
}

// 微任务冲刷：fake timers 下推进 0 次循环让 await 链走完
async function flush(n = 8) {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(0)
}

// 打开首连接并走完 assign→joined 落地时序。取「最后一个」实例：
// 同一测试里先后有两个 runner 时，新 start 的 socket 在数组尾部
function land(ctx, { online = 1, roomId = 'roomA', nick = 'ANON-7K2Q' } = {}) {
  ctx.runner.start()
  const s = StubSocket.instances[StubSocket.instances.length - 1]
  s.open()
  s.emit({ type: 'assign', nick })
  s.emit({ type: 'joined', roomId, selfId: 42, online })
  return s
}

describe('createBotRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    StubSocket.instances = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('入站 message → buffer.push + activity + decide 命中 → think sleep → fetch → typing sleep → send + usage 进 onState', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5, 0, 0.5, 0.9, 0.5]) }) // streak, prob命中, think=5000, typing=1900, afk不中
    const s = land(ctx)
    expect(framesOf(s)).toEqual([{ type: 'join', roomId: 'roomA' }])
    ctx.events.length = 0 // 只看消息帧之后的事件

    s.emit(msgFrame({ id: 'p1', ts: 50 }))
    expect(ctx.runner.getBuffer().map((f) => f.id)).toEqual(['p1'])
    expect(ctx.events[0]).toEqual({ t: 'activity', payload: { roomId: 'roomA' } })
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([5000])

    ctx.resolveSleep()
    await flush()
    expect(ctx.fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = ctx.fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.example/v1/chat/completions')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(init.body)
    expect(body.model).toBe('test-model')
    expect(body.temperature).toBe(0.7)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('Nova')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'ANON-H1: 今天天气不错' })
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([1900])

    ctx.resolveSleep()
    await flush()
    const sent = framesOf(s).filter((f) => f.type === 'message')
    expect(sent).toEqual([{ type: 'message', text: '你好呀，朋友', badge: 'BOT·Nova' }])
    const buf = ctx.runner.getBuffer()
    expect(buf).toHaveLength(2)
    expect(buf[1].nick).toBe('ANON-7K2Q')
    expect(buf[1].text).toBe('你好呀，朋友')
    const last = ctx.patches[ctx.patches.length - 1]
    expect(last.session).toEqual({ promptTokens: 11, completionTokens: 7, messages: 1 })
    expect(last.hourCount).toBe(1)
  })

  it('总延迟封顶：think 8000 + typing 12000 → 第二段只睡 7000；超长回复截 280', async () => {
    const ctx = makeRunner({
      rng: mkRng([0.5, 0, 1, 1, 0.5]), // streak, prob命中, think=8000, typing=6段×2000=12000, afk不中
      fetchImpl: vi.fn(async () => llmOk('a'.repeat(300))),
    })
    const s = land(ctx)
    s.emit(msgFrame())
    ctx.resolveSleep()
    await flush()
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([7000])
    ctx.resolveSleep()
    await flush()
    const sent = framesOf(s).filter((f) => f.type === 'message')
    expect(sent[0].text).toHaveLength(MAX_TEXT)
  })

  it('B3: nick === 自己 nick 的帧丢弃（不进 buffer、不触发决策），点名自己也不触发', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5]) }) // 只消耗构造 streakLimit
    const s = land(ctx, { nick: 'ANON-SELF' })
    s.emit(msgFrame({ nick: 'ANON-SELF', text: 'nova 我说的' }))
    expect(ctx.runner.getBuffer()).toEqual([])
    expect(ctx.events.map((e) => e.t)).toEqual(['nick']) // 只有落地时的 assign 上报，无 activity
    expect(ctx.sleepQ).toHaveLength(0)
    expect(ctx.fetchImpl).not.toHaveBeenCalled()
  })

  it('B7: LLM 在途时 switchRoom → 响应作废不发、buffer 清空、join 新房；旧房在途帧不再入 buffer', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5, 0, 0.5]) })
    const s = land(ctx)
    const fd = deferred()
    ctx.fetchImpl.mockReturnValue(fd.promise)
    s.emit(msgFrame())
    ctx.resolveSleep() // think 到期 → fetch 在途
    await flush()
    expect(ctx.fetchImpl).toHaveBeenCalledTimes(1)

    ctx.runner.switchRoom('roomB')
    expect(ctx.runner.getBuffer()).toEqual([])
    expect(framesOf(s).filter((f) => f.type === 'join')).toEqual([
      { type: 'join', roomId: 'roomA' },
      { type: 'join', roomId: 'roomB' },
    ])
    fd.resolve(llmOk('晚到的回复'))
    await flush()
    expect(framesOf(s).filter((f) => f.type === 'message')).toEqual([])
    expect(ctx.sleepQ).toHaveLength(0) // typing 段不再睡

    // 旧房迟到帧：roomId 与 currentRoomId 不符 → 拒
    s.emit(msgFrame({ roomId: 'roomA', id: 'ghost' }))
    expect(ctx.runner.getBuffer()).toEqual([])
  })

  it('history: joined online>1 → history-req；2000ms 窗口收集（错房帧拒收）→ mergeHistory 进 buffer 并 ≤200', async () => {
    const ctx = makeRunner()
    const s = land(ctx, { online: 3 })
    expect(framesOf(s).map((f) => f.type)).toEqual(['join', 'history-req'])
    s.emit(msgFrame({ id: 'live1', ts: 50 }))

    s.emit({ type: 'history-res', roomId: 'roomX', from: 7, messages: [msgFrame({ id: 'ghost', roomId: 'roomX' })] })
    s.emit({
      type: 'history-res', roomId: 'roomA', from: 7,
      messages: [msgFrame({ id: 'x1', ts: 10 }), msgFrame({ id: 'x2', ts: 20 })],
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctx.runner.getBuffer().map((f) => f.id)).toEqual(['x1', 'x2', 'live1'])

    // 窗口已关：迟到响应不再触发合并
    s.emit({ type: 'history-res', roomId: 'roomA', from: 7, messages: [msgFrame({ id: 'late', ts: 99 })] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctx.runner.getBuffer().map((f) => f.id)).toEqual(['x1', 'x2', 'live1'])

    // 切房重进：新窗口 250 条响应 → replace 截到 200 丢最旧
    ctx.runner.switchRoom('roomC')
    s.emit({ type: 'joined', roomId: 'roomC', selfId: 42, online: 2 })
    const many = Array.from({ length: 250 }, (_, i) => msgFrame({ id: `h${i}`, ts: i, roomId: 'roomC' }))
    s.emit({ type: 'history-res', roomId: 'roomC', from: 8, messages: many })
    await vi.advanceTimersByTimeAsync(2000)
    const buf = ctx.runner.getBuffer()
    expect(buf).toHaveLength(200)
    expect(buf[0].id).toBe('h50')
    expect(buf[199].id).toBe('h249')
  })

  it('rate 帧 → penalize + status cooling；连续 3 个 rate → stop("SLOW DOWN") 亮红', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5, 0.5]) }) // streak；penalize#1 掷全新冷却；#2/#3 剩余翻倍不再掷
    const s = land(ctx)
    s.emit({ type: 'rate', ts: 1 })
    const coolingPatch = ctx.patches[ctx.patches.length - 1]
    expect(coolingPatch.status).toBe('cooling')

    s.emit({ type: 'rate', ts: 2 })
    s.emit({ type: 'rate', ts: 3 })
    const last = ctx.patches[ctx.patches.length - 1]
    expect(last.status).toBe('error')
    expect(last.error).toBe('SLOW DOWN')
    expect(ctx.events).toContainEqual({ t: 'stopped', payload: 'SLOW DOWN' })
    expect(s.closedRequested).toBe(true)
  })

  it('join-error unknown → 1s 间隔重试 join 至 3 次 → 第 4 个错误 stop 报因', async () => {
    const ctx = makeRunner()
    ctx.runner.start()
    const s = StubSocket.instances[0]
    s.open()
    for (let i = 0; i < 3; i++) {
      s.emit({ type: 'join-error', roomId: 'roomA', reason: 'unknown' })
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(framesOf(s).filter((f) => f.type === 'join')).toHaveLength(4) // 首 join + 3 重试
    s.emit({ type: 'join-error', roomId: 'roomA', reason: 'unknown' })
    const last = ctx.patches[ctx.patches.length - 1]
    expect(last.status).toBe('error')
    expect(last.error).toBe('NO SUCH ROOM')
    expect(ctx.events).toContainEqual({ t: 'stopped', payload: 'NO SUCH ROOM' })
  })

  it('LlmError auth → 立即 stop("TOKEN 失效")；rate 类 → 本次放弃 bot 继续运行', async () => {
    // auth
    const a = makeRunner({
      rng: mkRng([0.5, 0, 0.5]),
      sleepMode: 'auto',
      fetchImpl: vi.fn(async () => httpError(401)),
    })
    const sa = land(a)
    sa.emit(msgFrame())
    await flush()
    const lastA = a.patches[a.patches.length - 1]
    expect(lastA.status).toBe('error')
    expect(lastA.error).toBe('TOKEN 失效')
    expect(lastA.error).not.toContain(KEY)
    expect(sa.closedRequested).toBe(true)

    // rate：两次 429（重试一次由 llm 内部完成）→ 放弃本次、无 stopped 事件、仍可再接话
    const b = makeRunner({
      rng: mkRng([0.5, 0, 0.5, 0, 0.5]),
      sleepMode: 'auto',
      fetchImpl: vi.fn(async () => httpError(429)),
    })
    const sb = land(b)
    sb.emit(msgFrame())
    await flush()
    expect(b.fetchImpl).toHaveBeenCalledTimes(2) // 首发 + 重试一次
    expect(b.events.find((e) => e.t === 'stopped')).toBeUndefined()
    expect(b.runner.getState().status).toBe('open') // 仍在运行，未停用
    sb.emit(msgFrame({ id: 'p2' }))
    await flush()
    expect(b.fetchImpl).toHaveBeenCalledTimes(4) // bot 还活着
  })

  it('pokeIdle：冷却/AFK 门禁下不发；正常走同管道且 buildMessages idle=true', async () => {
    // 门禁：rate 进冷却后 pokeIdle 静默
    const g = makeRunner({ rng: mkRng([0.5, 0.5]) })
    const sg = land(g)
    sg.emit({ type: 'rate', ts: 1 })
    g.runner.pokeIdle()
    expect(g.fetchImpl).not.toHaveBeenCalled()
    expect(g.sleepQ).toHaveLength(0)

    // 门禁二：transport 仍 connecting（socket 未 open）→ 静默且不掷 rollIdle 骰（mkRng 只留构造 1 掷）
    const c = makeRunner({ rng: mkRng([0.5]) })
    c.runner.start()
    c.runner.pokeIdle()
    expect(c.fetchImpl).not.toHaveBeenCalled()
    expect(c.sleepQ).toHaveLength(0)

    // 正路：rollIdle 命中 → think → fetch（messages 尾附 IDLE_KICK）→ typing → send
    const ctx = makeRunner({ rng: mkRng([0.5, 0, 0.5, 0.5, 0.5]) }) // streak, idle命中, think=5000, typing=1500, afk不中
    const s = land(ctx)
    ctx.runner.pokeIdle()
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([5000])
    ctx.resolveSleep()
    await flush()
    const body = JSON.parse(ctx.fetchImpl.mock.calls[0][1].body)
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'system', content: IDLE_KICK })
    ctx.resolveSleep()
    await flush()
    expect(framesOf(s).filter((f) => f.type === 'message')).toHaveLength(1)
  })

  it('idleEligible/idleRoll 暴露（审查轮 1 #1）：门禁查询不掷骰；idleRoll 恰 1 掷；rate 冷却即 false', async () => {
    // mkRng 逐值弹出+耗尽即抛 → 精确记账：构造 1 掷 + rate 冷却 1 掷，其余 0
    const ctx = makeRunner({ rng: mkRng([0.5, 0.5]) })
    expect(ctx.runner.idleEligible()).toBe(false) // 未 start：rhythm 尚不存在
    const s = land(ctx) // start → rhythm 构造（第 1 掷）；open + joined
    expect(ctx.runner.idleEligible()).toBe(true) // 不消耗 rng（第 2 掷预留给 rate）
    ctx.runner.idleEligible()
    s.emit({ type: 'rate', ts: 1 }) // penalize 掷全新冷却（第 2 掷）
    expect(ctx.runner.idleEligible()).toBe(false) // B21 门禁经真 rhythm
    // idleRoll 恰 1 掷：chattiness 50 → factor 1 → 阈值 0.3；0.2 命中（mkRng 无余值→多掷即抛）
    const b = makeRunner({ rng: mkRng([0.5, 0.2]) }) // 构造 + rollIdle
    land(b)
    expect(b.runner.idleRoll()).toBe(true)
    // transport 未开 → eligible false
    const c = makeRunner({ rng: mkRng([0.5]) })
    c.runner.start() // 仅构造 1 掷
    expect(c.runner.idleEligible()).toBe(false)
  })

  it('pokeIdle({preRolled:true})（审查轮 1 #1）：跳过内部 canInitiateIdle/rollIdle，保留 transport 门禁；无参行为不变', async () => {
    // 冷却中：无参 pokeIdle 静默（既有行为）；preRolled 直发——store 已问过 idleEligible+idleRoll
    const ctx = makeRunner({ rng: mkRng([0.5, 0.5, 0.5, 0.5]) }) // 构造; rate 冷却; think=5000; typing=1500（preRolled 未再掷 rollIdle——第 3 掷即 think）
    const s = land(ctx)
    s.emit({ type: 'rate', ts: 1 })
    ctx.runner.pokeIdle()
    expect(ctx.sleepQ).toHaveLength(0)
    ctx.runner.pokeIdle({ preRolled: true })
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([5000]) // 不再问 rhythm 门禁、不再掷 rollIdle
    ctx.resolveSleep()
    await flush()
    expect(ctx.fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(ctx.fetchImpl.mock.calls[0][1].body)
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'system', content: IDLE_KICK })
    // transport 门禁保留：socket 未 open → preRolled 也不发（rng 仅够构造，多发即抛）
    const c = makeRunner({ rng: mkRng([0.5]) })
    c.runner.start()
    c.runner.pokeIdle({ preRolled: true })
    expect(c.sleepQ).toHaveLength(0)
    expect(c.fetchImpl).not.toHaveBeenCalled()
  })

  it('mentions 标志：text 含 bot 名子串大小写不敏感；非点名在低概率下不触发', async () => {
    // chattiness=0 → factor 0.2：人类基础 0.08 ≤ 0.1 < 点名 0.18——rng 恒 0.1 只有点名命中
    const ctx = makeRunner({ bot: { chattiness: 0 }, rng: always(0.1) })
    const s = land(ctx)
    s.emit(msgFrame({ text: 'NOVA 出来聊聊' })) // 含 Nova（大小写不敏感）→ 命中
    expect(ctx.sleepQ).toHaveLength(1)
    s.emit(msgFrame({ id: 'p2', text: '天气不错' })) // 非点名 → 概率不中
    expect(ctx.sleepQ).toHaveLength(1)
  })

  it('B10: 发言期间在途 ≤1 个 LLM 请求；pending 至多 1，第三个命中丢弃', async () => {
    let active = 0
    let maxActive = 0
    let callI = 0
    const fds = [deferred(), deferred()]
    const fetchImpl = vi.fn(() => {
      active++
      maxActive = Math.max(maxActive, active)
      const fd = fds[callI++]
      return fd.promise.then((r) => {
        active--
        return r
      })
    })
    const ctx = makeRunner({
      rng: mkRng([0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.5]), // streak; f1 p+t; f2 p+t; f3 p+t（decide 命中即掷，槽占后整 job 丢弃）; f1 typing+afk; f2 typing+afk
      fetchImpl,
    })
    const s = land(ctx)
    s.emit(msgFrame({ id: 'f1' }))
    ctx.resolveSleep()
    await flush() // f1 进 fetch 在途
    s.emit(msgFrame({ id: 'f2' })) // → pending 槽
    s.emit(msgFrame({ id: 'f3' })) // → 槽已占，直接丢弃
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(maxActive).toBe(1)

    fds[0].resolve(llmOk('回复一'))
    await flush()
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([1500]) // f1 typing（'回复一'3字→1段×1500）
    ctx.resolveSleep()
    await flush() // f1 发出 → pending 的 f2 启动，think 5000 入队
    expect(fetchImpl).toHaveBeenCalledTimes(1) // f2 还在 think，未进 fetch
    expect(ctx.sleepQ.map((x) => x.ms)).toEqual([5000])
    expect(maxActive).toBe(1)

    ctx.resolveSleep()
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1) // f2 的 fetch 开始时 f1 已完成 → 并发仍为 1
    fds[1].resolve(llmOk('回复二'))
    await flush()
    ctx.resolveSleep() // f2 typing
    await flush()
    const sent = framesOf(s).filter((f) => f.type === 'message')
    expect(sent.map((f) => f.text)).toEqual(['回复一', '回复二'])
    expect(fetchImpl).toHaveBeenCalledTimes(2) // f3 被丢弃：永远没有第三次请求
  })

  it('B11: WS 断开 → 退避重连 rejoin，runner 状态回 open，hourCount 保留、冷却显示重置', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5, 0, 0.5, 0.5, 0.5, 0.5]) }) // streak; 发言 prob/think/typing/afk; penalize 掷冷却
    const s1 = land(ctx)
    s1.emit(msgFrame())
    ctx.resolveSleep()
    await flush()
    ctx.resolveSleep()
    await flush()
    expect(ctx.runner.getState().hourCount).toBe(1)

    s1.emit({ type: 'rate', ts: 9 })
    expect(ctx.patches[ctx.patches.length - 1].status).toBe('cooling')

    s1.fail(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const s2 = StubSocket.instances[1]
    expect(s2).toBeTruthy()
    s2.open()
    expect(framesOf(s2)).toEqual([{ type: 'join', roomId: 'roomA' }]) // connection 自动 rejoin
    s2.emit({ type: 'joined', roomId: 'roomA', selfId: 42, online: 1 })
    const st = ctx.patches[ctx.patches.length - 1]
    expect(st.status).toBe('open')
    expect(ctx.runner.getState().hourCount).toBe(1) // rhythm 实例保留
    expect(StubSocket.instances).toHaveLength(2)
  })

  it('B9/配置校验：baseUrl/model 缺失 → error 文案不含 apiKey 且不连接；stop 原因均经 redact', async () => {
    const a = makeRunner({ provider: { baseUrl: '', apiKey: KEY } })
    a.runner.start()
    expect(StubSocket.instances).toHaveLength(0)
    const lastA = a.patches[a.patches.length - 1]
    expect(lastA.status).toBe('error')
    expect(lastA.error).toContain('baseUrl')
    expect(lastA.error).not.toContain(KEY)

    const b = makeRunner({ bot: { model: '' } })
    b.runner.start()
    expect(StubSocket.instances).toHaveLength(0)
    expect(b.patches[b.patches.length - 1].error).toContain('model')
  })

  it('镜像帧 id 含 bot.id 段：家族多 bot 各自发言后 local-<botId>-N 互不撞号（审查轮 1）', async () => {
    // 撞号后果（修复前）：两 bot 响应 history-req 都带 id=local-1 且内容不同 →
    // mergeHistory 判「跨响应者同 id 内容冲突」= 伪造篡改信号，两条一起被丢
    const a = makeRunner({ bot: { id: 'bA' }, rng: mkRng([0.5, 0, 0.5, 0.9, 0.5]) })
    const sa = land(a)
    sa.emit(msgFrame())
    a.resolveSleep()
    await flush()
    a.resolveSleep()
    await flush()
    const b = makeRunner({ bot: { id: 'bB' }, rng: mkRng([0.5, 0, 0.5, 0.9, 0.5]) })
    const sb = land(b)
    sb.emit(msgFrame())
    b.resolveSleep()
    await flush()
    b.resolveSleep()
    await flush()

    const fa = a.runner.getBuffer()[a.runner.getBuffer().length - 1]
    const fb = b.runner.getBuffer()[b.runner.getBuffer().length - 1]
    expect(fa.id).toBe('local-bA-1')
    expect(fb.id).toBe('local-bB-1')
    expect(fa.id).not.toBe(fb.id)
    // 且经 mergeHistory 不再互相湮灭：a 的 buffer 作 existing、b 的帧作响应，两条同留
  })

  it('stop 后管道整体熄火：在途 job 作废、定时器清挂、重复 stop 幂等', async () => {
    const ctx = makeRunner({ rng: mkRng([0.5, 0, 0.5]) })
    const s = land(ctx)
    s.emit(msgFrame())
    ctx.runner.stop('用户停止')
    expect(ctx.patches[ctx.patches.length - 1].status).toBe('stopped')
    expect(ctx.events).toContainEqual({ t: 'stopped', payload: '用户停止' })
    ctx.resolveSleep() // think 定时器解除 → 在途 job 应直接终止
    await flush()
    expect(ctx.fetchImpl).not.toHaveBeenCalled()
    expect(() => ctx.runner.stop('再来一次')).not.toThrow()
  })
})

