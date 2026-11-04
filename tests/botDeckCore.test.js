// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createNullLease, createDeck, CONFIG_KEY, SCHEMA_VERSION, HEARTBEAT_MS, HOUR_MS } from 'kuoluosaigai-bot-core'

// Mapish —— createTabLease 的 storage 注入契约就是 {getItem,setItem,removeItem}
// 三个方法（见 src/bots/lease.js），这里自建一个 Map 封装，不引新测试依赖。
class Mapish {
  #map = new Map()
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null }
  setItem(k, v) { this.#map.set(k, String(v)) }
  removeItem(k) { this.#map.delete(k) }
}

// fakeRunner —— deck.js 对 runner 的全部调用面，照 store.js 现状取齐（Task 4 brief）。
function fakeRunner() {
  return {
    start() {},
    stop() {},
    switchRoom() {},
    clearBuffer() {},
    getBuffer() { return [] },
    idleEligible() { return false },
    idleRoll() { return false },
    pokeIdle() {},
  }
}

describe('lease 端口（daemon 用恒真实现）', () => {
  it('本测试跑在 node 环境：没有浏览器全局（Review Focus 2 的前提）', () => {
    expect(typeof globalThis.localStorage).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
  })

  it('六个成员齐备且语义恒真', async () => {
    const l = createNullLease()
    expect(await l.acquire('bot-0')).toBe(true)
    expect(l.isHeldElsewhere('bot-0')).toBe(false)
    expect(l.degraded).toBe(false)
    expect(() => { l.release('bot-0'); l.releaseAll(); l.heartbeat('bot-0') }).not.toThrow()
  })

  it('与浏览器 createTabLease 同名同形（端口契约，不是两套实现）', async () => {
    const { createTabLease } = await import('../src/bots/lease.js')
    const browser = createTabLease({ storage: new Mapish() })
    const nulls = createNullLease()
    expect(Object.keys(nulls).sort()).toEqual(
      ['acquire', 'release', 'releaseAll', 'heartbeat', 'isHeldElsewhere', 'degraded'].sort())
    for (const k of ['acquire', 'release', 'releaseAll', 'heartbeat', 'isHeldElsewhere']) {
      expect(typeof browser[k], `浏览器侧缺 ${k}`).toBe('function')
    }
  })
})

describe('createDeck（store 逻辑的宿主无关核心，Task 4）', () => {
  // (a) 零浏览器全局可用：Map storage + 恒等 reactive + null lease，起一个 bot 不炸
  it('纯 Node 环境下 addBot→persist→load roundtrip，载荷键与格式不变', async () => {
    const storage = new Mapish()
    const deck = createDeck({ storage })
    deck.addProvider({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' })
    deck.addBot({ name: '小李', persona: 'p', chattiness: 50, roomId: 'nebula' })
    expect(storage.getItem('kuoluosaigai:bots:v1')).toBeTruthy()
    const payload = JSON.parse(storage.getItem('kuoluosaigai:bots:v1'))
    expect(payload.version).toBe(1)
    expect(Object.keys(payload).sort()).toEqual(['bots', 'lifetime', 'providers', 'version'])
  })

  // (b) reactiveImpl 被真的用上（不是留在 core 里的 import）
  it('reactiveImpl 收到 store 字面量，且方法都在其后', async () => {
    const seen = []
    createDeck({ storage: new Mapish(), reactiveImpl: (o) => { seen.push(o); return o } })
    expect(seen).toHaveLength(1)
    expect(typeof seen[0].startBot).toBe('function')
  })

  // (b2) I2：reactive 接缝的包内唯一防线——方法的写入必须流经 reactiveImpl 的「返回值」。
  // 浏览器注入的是 vue reactive 代理；若哪天有人把闭包改成写包装前的字面量（等价于
  // `raw.bots.push`），浏览器 UI 会静默失去响应性，而 core 自己的套件（(b) 用恒等
  // 实现）与 jsdom 组件测试都可能照样绿。本用例是包内、node 环境、零新依赖的钉死。
  // 注意单层 Proxy 抓不到 `store.bots.push`——get 陷阱返回原始数组、push 不经代理，
  // 所以 get 陷阱逐层包装嵌套对象/数组（逼近 vue 深 reactive 的可观察面），push 的
  // 索引与 'length' 写才会落进 set 陷阱。基线差值断言：构造期 loadInto 可能已有写入，
  // 本用例只关心 addBot 这一次调用引入的写。
  it('addBot 的写入流经 reactiveImpl 返回的代理对象（不回写包装前字面量）', () => {
    const sets = []
    const wrap = (t) => new Proxy(t, {
      get(o, k, r) {
        const v = Reflect.get(o, k, r)
        return v !== null && typeof v === 'object' ? wrap(v) : v
      },
      set(o, k, v) { sets.push(k); o[k] = v; return true },
    })
    const deck = createDeck({ storage: new Mapish(), reactiveImpl: wrap })
    const baseline = sets.length
    deck.addBot({ name: '小李' })
    const introduced = sets.slice(baseline)
    expect(introduced).toContain('0') // store.bots.push 的元素写经代理
    expect(introduced).toContain('length') // 以及其后的 length 维护
    expect(deck.bots.length).toBe(1) // 数据也确实落进了返回值
  })

  // (c) null lease 下 startBot 直通，不置 otherTab
  it('null lease：startBot 成功、rt.otherTab 恒 false', async () => {
    const started = []
    const deck = createDeck({
      storage: new Mapish(),
      deps: { createRunner: (o) => { started.push(o.bot.id); return fakeRunner() } },
    })
    deck.addBot({ id: 'bot-0', name: '小李', providerId: null, roomId: 'nebula' })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(started).toEqual(['bot-0'])
    expect(deck.bots[0].rt.otherTab).toBe(false)
    deck.dispose()   // startBot 会 ensureTick() 起 setInterval；node 环境不留活句柄（R4）
  })

  // (d) storage 缺失明确报错，别静默用 globalThis.localStorage
  it('不传 storage → TypeError（禁止 core 摸浏览器全局）', () => {
    expect(() => createDeck({})).toThrow(/storage/)
  })

  it('P4 humanize 默认 true 并下传 runner；可显式关闭；humanizeRng 原样透传', async () => {
    const seen = []
    const hr = () => 0.5
    const deck = createDeck({
      storage: new Mapish(),
      humanize: false,
      deps: {
        humanizeRng: hr,
        createRunner: (o) => { seen.push(o); return fakeRunner() },
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await deck.startBot('bot-0')
    expect(seen[0].humanize).toBe(false)
    expect(seen[0].humanizeRng).toBe(hr)
    deck.dispose()

    const seen2 = []
    const deck2 = createDeck({
      storage: new Mapish(),
      deps: { createRunner: (o) => { seen2.push(o); return fakeRunner() } },
    })
    deck2.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await deck2.startBot('bot-0')
    expect(seen2[0].humanize).toBe(true)
    expect('humanizeRng' in seen2[0]).toBe(false)
    deck2.dispose()
  })

  // (e) Q7 观测端口（P1 Task 1）：deps.onEvent 宿主汇收到 (type, {botId, ...payload})。
  // 发射端契约由 botRunner.test.js 钉死；本组用例只钉 deck→宿主 转发这一段：
  // error/warn 转、活动类内部事件（activity/nick/stopped）不转、不注入时不抛。
  it('deps.onEvent 宿主汇：error/warn 带 botId 转发，activity/nick/stopped 不透传', async () => {
    const seen = []
    const deck = createDeck({
      storage: new Mapish(),
      deps: {
        onEvent: (type, payload) => seen.push({ type, payload }),
        createRunner: (o) => emittingRunner(o, [
          { t: 'activity', payload: { roomId: 'nebula', family: false } },
          { t: 'nick', payload: { nick: 'ANON-9Q' } },
          { t: 'error', payload: { kind: 'rate', message: 'LLM 调用失败: rate（HTTP 429）', fatal: false } },
          { t: 'warn', payload: { reason: 'SLOW DOWN' } },
          { t: 'stopped', payload: 'SLOW DOWN' },
        ]),
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(seen).toEqual([
      { type: 'error', payload: { botId: 'bot-0', kind: 'rate', message: 'LLM 调用失败: rate（HTTP 429）', fatal: false } },
      { type: 'warn', payload: { botId: 'bot-0', reason: 'SLOW DOWN' } },
    ])
    deck.dispose() // startBot 起 setInterval，node 环境不留活句柄（R4）
  })

  it('不注入 deps.onEvent 时 runner 发 error/warn 不抛（浏览器侧逐字节如现状）', async () => {
    const deck = createDeck({
      storage: new Mapish(),
      deps: {
        createRunner: (o) => emittingRunner(o, [
          { t: 'error', payload: { kind: 'server', message: 'LLM 调用失败: server（HTTP 503）', fatal: false } },
          { t: 'warn', payload: { reason: 'SLOW DOWN' } },
        ]),
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await expect(deck.startBot('bot-0')).resolves.toBe(true)
    expect(deck.bots[0].rt.status).toBe('connecting') // 转发缺席不改启动语义
    deck.dispose()
  })
})

// emittingRunner —— fakeRunner 的 start() 改为按序经 runner 端口 o.onEvent 回放事件，
// 走 deck 的 handleEvent 全链路（activity/nick/stopped 的既有内部消费照常发生）。
function emittingRunner(o, events) {
  const r = fakeRunner()
  r.start = () => { for (const e of events) o.onEvent(e.t, e.payload) }
  return r
}

// —— schedule 刹车端口（P1 Task 2 / spec Q9 + §12）——
// gate 本体语义（跨零点窗/fail-closed/点名放行）已由 botSchedule.test.js 钉死；
// 这里只测 deck 接线面：不传 schedule → runner opts 连 gate 键都不出现（浏览器零
// 变化）；传了 → 闲置发起被前置判定，心跳等簿记不受牵连。调度器用脚本化替身
// （tick 恒判首候选中签）——窗口/骰子内部归 botRhythm 套件，本组关心 deck 开问
// gate 的时序。墙钟基准取「无时区后缀」本地串，跨执行机时区稳定。
describe('schedule 刹车端口（Q9+§12，daemon 注入、浏览器缺省不启用）', () => {
  const at = (hhmm) => Date.parse(`2026-11-04T${hhmm}:00`)
  const newRec = () => ({ pokes: [], ticks: [], hb: 0 })

  function spyRunner(rec) {
    const r = fakeRunner()
    r.pokeIdle = (o) => rec.pokes.push(o === undefined ? null : o)
    return r
  }
  function scriptedScheduler(rec) {
    return () => ({
      notifyActivity() {},
      tick(cands) {
        rec.ticks.push(cands.map((c) => c.id))
        return cands.length ? cands[0].id : null
      },
    })
  }
  const heartbeatLease = (rec) => ({
    acquire: async () => true,
    release: () => {},
    releaseAll: () => {},
    heartbeat: () => { rec.hb += 1 },
    isHeldElsewhere: () => false,
    degraded: false,
  })

  // 统一起局：t 落在本地正午（默认无 quietHours 时任何用例都不会误触静默窗）
  function deckWith(rec, over = {}) {
    let t = typeof over.at === 'number' ? over.at : at('12:00')
    const advance = (ms) => {
      t += ms
      vi.advanceTimersByTime(ms)
    }
    let optsSeen = null
    const deck = createDeck({
      storage: new Mapish(),
      now: () => t,
      lease: heartbeatLease(rec),
      schedule: over.schedule,
      deps: {
        createRunner: (o) => {
          optsSeen = o
          return spyRunner(rec)
        },
        createScheduler: scriptedScheduler(rec),
        ...(over.onEvent ? { onEvent: over.onEvent } : {}), // 审查#1：宿主汇可选注入
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    return { deck, advance, nowT: () => t, getOpts: () => optsSeen }
  }

  it('createDeck 未配置 schedule → runner 收到的 gate 为 undefined（连键都不出现；浏览器默认不启用）', async () => {
    const rec = newRec()
    const { deck, getOpts } = deckWith(rec)
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(getOpts()).toBeTruthy()
    expect('gate' in getOpts()).toBe(false)
    expect(getOpts().gate).toBeUndefined()
    deck.dispose()
  })

  it('传 schedule → runner 收到带 { quietNow, allowSpeak } 的 gate 对象', async () => {
    const rec = newRec()
    const { deck, getOpts } = deckWith(rec, { schedule: { quietHours: { from: '01:30', to: '08:00' } } })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(typeof getOpts().gate.allowSpeak).toBe('function')
    expect(typeof getOpts().gate.quietNow).toBe('function')
    deck.dispose()
  })

  it('回归护栏：不传 schedule → 冷场闲置照常发起（刹车缺省不咬人，既有语义不变）', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      const { deck, advance } = deckWith(rec)
      expect(await deck.startBot('bot-0')).toBe(true)
      advance(HEARTBEAT_MS * 4)
      expect(rec.ticks).toEqual([['bot-0'], ['bot-0'], ['bot-0'], ['bot-0']])
      expect(rec.pokes).toEqual([{ preRolled: true }, { preRolled: true }, { preRolled: true }, { preRolled: true }])
      expect(rec.hb).toBe(4)
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quietHours 覆盖当前墙钟 → 闲置不发起、心跳照打；出窗即自动解除', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      const { deck, advance, nowT } = deckWith(rec, {
        at: at('03:00'),
        schedule: { quietHours: { from: '01:30', to: '08:00' } },
      })
      expect(await deck.startBot('bot-0')).toBe(true)
      advance(HEARTBEAT_MS * 4) // 03:01，窗内
      expect(rec.ticks).toEqual([]) // 闲置发起整体跳过
      expect(rec.pokes).toEqual([])
      expect(rec.hb).toBe(4) // 刹车只拦「开口花钱」，不拦簿记
      const target = at('08:15') // 逐班车推到出窗（to 不含 → 08:00 起放行）
      while (nowT() < target) advance(HEARTBEAT_MS)
      expect(rec.ticks.length).toBeGreaterThan(0)
      expect(rec.pokes.length).toBeGreaterThan(0)
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('startupQuietMs：deck 构造后 N 分钟内闲置抑制，恰满 N 分钟的那班车解除', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      const { deck, advance } = deckWith(rec, { schedule: { startupQuietMs: 120000 } })
      expect(await deck.startBot('bot-0')).toBe(true)
      advance(HEARTBEAT_MS * 7) // 累计 105000 < 120000，仍静默
      expect(rec.ticks).toEqual([])
      expect(rec.pokes).toEqual([])
      advance(HEARTBEAT_MS) // 第 8 班车恰满 120000 → 严格小于语义，此刻放行
      expect(rec.ticks.length).toBe(1)
      expect(rec.pokes).toEqual([{ preRolled: true }])
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedule 传空对象 → 建 gate 但恒不静默（配置了≠全静默；发起照常）', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      const { deck, advance, getOpts } = deckWith(rec, { schedule: {} })
      expect(await deck.startBot('bot-0')).toBe(true)
      expect(typeof getOpts().gate.allowSpeak).toBe('function')
      advance(HEARTBEAT_MS * 2)
      expect(rec.ticks.length).toBe(2)
      expect(rec.pokes.length).toBe(2)
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // —— 审查轮 1 Important #1 修复：配置故障必须自我 announce（一次性 warn 上宿主汇）——
  // fail-closed/fail-open 语义本体由 botSchedule.test.js 钉死且不许翻转；这里只补可见性：
  // quietHours 在场但端点坏 → 全时段静默是「已生效的故障」，构造 gate 时一次性 warn；
  // schedule 内未知键（大小写笔误等）同样 warn（键被忽略 = 潜在失效刹车）。
  // 端口形状钉死：deck 级配置告警无 botId——载荷不含 botId 键（缺席 ≠ null，防消费方
  // 把「无主事件」误标成某 bot）。缺席语义不动：schedule/quietHours 不存在是合法的
  // 「操作者没装刹车」（浏览器与 opt-out 宿主），不是故障，不 warn。

  it('审查#1：quietHours 端点不可解析 → 构造期一次性 warn（reason 固定串），载荷不含 botId 键', async () => {
    const seen = []
    const rec = newRec()
    const { deck, getOpts } = deckWith(rec, {
      schedule: { quietHours: { from: '25:00', to: '08:00' } },
      onEvent: (type, payload) => seen.push({ type, payload }),
    })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(seen).toEqual([
      { type: 'warn', payload: { reason: 'schedule.quietHours unparseable -> quiet all day' } },
    ])
    expect('botId' in seen[0].payload).toBe(false)
    expect(typeof getOpts().gate.allowSpeak).toBe('function') // 闸门照建（fail-closed 语义不变）
    deck.dispose()
  })

  it('审查#1：quietHours 未知形状（字符串）→ 同样一次性 warn', async () => {
    const seen = []
    const rec = newRec()
    const { deck } = deckWith(rec, {
      schedule: { quietHours: '01:30-08:00' },
      onEvent: (type, payload) => seen.push({ type, payload }),
    })
    await deck.startBot('bot-0')
    expect(seen.map((e) => e.payload.reason)).toEqual([
      'schedule.quietHours unparseable -> quiet all day',
    ])
    deck.dispose()
  })

  it('审查#1：schedule 未知键（startupQuietMS 大小写笔误）→ warn 点名该键；键被忽略不误拦发起', async () => {
    vi.useFakeTimers()
    try {
      const seen = []
      const rec = newRec()
      const { deck, advance } = deckWith(rec, {
        schedule: { startupQuietMS: 60000 },
        onEvent: (type, payload) => seen.push({ type, payload }),
      })
      await deck.startBot('bot-0')
      expect(seen).toEqual([
        { type: 'warn', payload: { reason: 'schedule: unknown key ignored: startupQuietMS' } },
      ])
      advance(HEARTBEAT_MS) // 笔误键未被当成 startupQuietMs——不静默，发起照常
      expect(rec.ticks.length).toBe(1)
      expect(rec.pokes.length).toBe(1)
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('审查#1：未配置 schedule / quietHours 缺席 → 恒零 warn（缺席是合法 opt-out，不是故障）', async () => {
    const rec = newRec()
    const mk = (schedule, withEvent) =>
      deckWith(rec, {
        at: at('12:00'),
        schedule,
        ...(withEvent ? { onEvent: () => { rec.events = (rec.events || 0) + 1 } } : {}),
      })
    const a = mk({ quietHours: { from: '01:30', to: '08:00' }, startupQuietMs: 1000 }, true)
    const b = mk(undefined, true)
    const c = mk({}, true)
    await a.deck.startBot('bot-0')
    await b.deck.startBot('bot-0')
    await c.deck.startBot('bot-0')
    expect(rec.events === undefined || rec.events === 0).toBe(true)
    a.deck.dispose()
    b.deck.dispose()
    c.deck.dispose()
  })
})

// —— globalHourlyMessages 全局小时闸（P1 Task 3 / §12 成本刹车）——
// accountor 语义与合流顺序本体由 botSchedule.test.js 钉死；这里测 deck 接线三面：
// 1) 计数来源 = handleEvent 的 family activity 分支（不新开端口；真人消息不入账）；
// 2) 消费 = 同一个 gate（同一 accountor 单实例）透传给全部 runner——跨 bot 累加共享
//    预算，点名越得过静默窗、越不过全局闸；
// 3) Task 7 读面 = store.globalHourCount getter（配置→数字 / 未配置→null）。
// 滚动一律推进注入的 now 跨界，不真实休眠。
describe('globalHourlyMessages 全局小时闸（P1 Task 3 / §12）', () => {
  const at = (hhmm) => Date.parse(`2026-11-04T${hhmm}:00`)
  const newRec = () => ({ pokes: [], ticks: [] })

  // famEmitRunner：start() 时经 runner 端口连发 count 条自家发送 activity
  //（payload = { family:true, sent:true }，R12 判别位——形状对齐 runner.js runJob
  // 发送侧自报），并记录 pokeIdle。观察回声（收到自家消息）不带 sent，另有用例钉。
  function famEmitRunner(o, rec, count) {
    const r = fakeRunner()
    r.pokeIdle = (x) => rec.pokes.push(x === undefined ? null : x)
    r.start = () => {
      for (let i = 0; i < count; i++) o.onEvent('activity', { roomId: 'nebula', family: true, sent: true })
    }
    return r
  }
  const scriptedScheduler = (rec) => () => ({
    notifyActivity() {},
    tick(cands) {
      rec.ticks.push(cands.map((c) => c.id))
      return cands.length ? cands[0].id : null
    },
  })

  it('两个 bot 共用一个全局闸：累计到 cap 后 allowSpeak(true) 也变 false（点名不发）', async () => {
    const optsAll = []
    const deck = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: 2 },
      deps: { createRunner: (o) => { optsAll.push(o); return famEmitRunner(o, newRec(), 1) } },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    deck.addBot({ id: 'bot-1', name: '阿宽', roomId: 'nebula' })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(deck.globalHourCount).toBe(1)
    expect(optsAll[0].gate.allowSpeak(true)).toBe(true) // 预算未满：点名可越过（此刻连静默窗都没有）
    expect(await deck.startBot('bot-1')).toBe(true)
    expect(optsAll[1].gate).toBe(optsAll[0].gate) // 跨 bot 单实例：两个 runner 拿到的是同一个闸
    expect(deck.globalHourCount).toBe(2)
    expect(optsAll[0].gate.allowSpeak(false)).toBe(false)
    expect(optsAll[0].gate.allowSpeak(true)).toBe(false) // 满闸：点名也变 false（不发、更不调 LLM）
    deck.dispose()
  })

  it('家族 activity 每条 inc 一次；真人消息不 inc', async () => {
    const deck = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: 50 },
      deps: {
        createRunner: (o) => emittingRunner(o, [
          { t: 'activity', payload: { roomId: 'nebula', family: true, sent: true } },
          { t: 'activity', payload: { roomId: 'nebula', family: false } }, // 真人：不入账
          { t: 'activity', payload: { roomId: 'nebula' } }, // family 缺席：同样不入账
          { t: 'activity', payload: { roomId: 'nebula', family: true, sent: true } },
        ]),
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await deck.startBot('bot-0')
    expect(deck.globalHourCount).toBe(2) // 逐条 inc：两条家族发送 → 2；两条真人/缺省 → 0
    deck.dispose()
  })

  // R12 去重判别位：计数只认发送侧自报（sent:true），同房家族 bot 观察到自家消息
  // 的回声（family:true 无 sent）不得二次入账——否则 N 个同房 bot 时一条真实发送
  // 计 N 条，Task 7 的 meta.globalHourCount 最高虚报 5×（MAX_BOTS=5）。
  it('R12：A 自家发送（sent:true）入账 1；B 观察到同条回声（family:true 无 sent）不重复入账', async () => {
    const deck = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: 10 },
      deps: {
        // bot-0 = 发送者 A：runJob 尾部自报；bot-1 = 同房观察者 B：handleMessage 回声上报
        createRunner: (o) => emittingRunner(o, o.bot.id === 'bot-0' ? [
          { t: 'activity', payload: { roomId: 'nebula', family: true, sent: true } },
        ] : [
          { t: 'activity', payload: { roomId: 'nebula', family: true } }, // B 看到 A 的消息——不是它的发送
        ]),
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    deck.addBot({ id: 'bot-1', name: '阿宽', roomId: 'nebula' })
    await deck.startBot('bot-0')
    await deck.startBot('bot-1')
    expect(deck.globalHourCount).toBe(1) // 一次真实发送 = 入账 1（旧口径此处会是 2）
    deck.dispose()
  })

  // R14（审查轮 1 教条外溢）：坏 globalHourlyMessages 是「装错了的刹车」，必须自我
  // announce——与坏 quietHours 端点同块同格式（reason + 无 botId 键）；行为保持
  // R1 缺省（视同未配置、不建闸），合法性拒收的本职仍在 Task 4 validateConfig（R9）。
  it('R14：globalHourlyMessages 坏值（字符串/负数）→ 构造期一次性 warn（无 botId），闸视同未配置', async () => {
    const seen = []
    const rec = newRec()
    const deck = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: '10' },
      deps: {
        onEvent: (type, payload) => seen.push({ type, payload }),
        createRunner: (o) => famEmitRunner(o, rec, 3),
      },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    expect(await deck.startBot('bot-0')).toBe(true)
    expect(seen).toEqual([
      { type: 'warn', payload: { reason: 'schedule.globalHourlyMessages invalid -> global hourly gate not armed' } },
    ])
    expect('botId' in seen[0].payload).toBe(false) // deck 级配置告警载荷契约
    expect(deck.globalHourCount).toBe(null) // 坏值 = 未配置：不建闸、不记账
    deck.dispose()

    const seenNeg = []
    const deckNeg = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: -1 },
      deps: { onEvent: (type, payload) => seenNeg.push(payload) },
    })
    expect(deckNeg.globalHourCount).toBe(null)
    expect(seenNeg).toEqual([
      { reason: 'schedule.globalHourlyMessages invalid -> global hourly gate not armed' },
    ])
    deckNeg.dispose()

    // 反例守卫：cap=0 是合法的显式杀闸——不得误报 invalid warn，且闸确实建成（数字 0）
    const seenZero = []
    const deckZero = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: 0 },
      deps: { onEvent: (type, payload) => seenZero.push(payload) },
    })
    expect(seenZero).toEqual([])
    expect(deckZero.globalHourCount).toBe(0)
    deckZero.dispose()
  })

  it('跨过整点后 count() 归零（注入 now 推进 3600_001ms，不真实休眠）', async () => {
    let t = at('12:00')
    let gateSeen = null
    const deck = createDeck({
      storage: new Mapish(),
      now: () => t,
      schedule: { globalHourlyMessages: 2 },
      deps: { createRunner: (o) => { gateSeen = o.gate; return famEmitRunner(o, newRec(), 2) } },
    })
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await deck.startBot('bot-0')
    expect(deck.globalHourCount).toBe(2)
    expect(gateSeen.allowSpeak(true)).toBe(false)
    t += HOUR_MS - 1 // 差 1ms 仍是这一小时
    expect(deck.globalHourCount).toBe(2)
    t += 2 // 累计 3600_001ms 跨过整点
    expect(deck.globalHourCount).toBe(0)
    expect(gateSeen.allowSpeak(true)).toBe(true)
    deck.dispose()
  })

  it('globalHourlyMessages 未配置 → 闸恒可发（浏览器零变化）', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      let t = at('12:00')
      let gateSeen = null
      // 形态一：schedule 在但没配全局闸 → gate 恒放行，家族消息再多也不记账（null=没装刹车）
      const deck = createDeck({
        storage: new Mapish(),
        now: () => t,
        schedule: {},
        deps: {
          createRunner: (o) => { gateSeen = o.gate; return famEmitRunner(o, rec, 20) },
          createScheduler: scriptedScheduler(rec),
        },
      })
      deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
      expect(await deck.startBot('bot-0')).toBe(true)
      expect(gateSeen.allowSpeak(false)).toBe(true)
      expect(gateSeen.allowSpeak(true)).toBe(true)
      expect(deck.globalHourCount).toBe(null)
      vi.advanceTimersByTime(HEARTBEAT_MS * 4)
      t += HEARTBEAT_MS * 4
      expect(rec.ticks.length).toBe(4) // 闲置发起照常——未配置就是没装这道闸
      deck.dispose()

      // 形态二：连 schedule 都不传（浏览器路径）→ 家族 activity 也不炸、不记账
      const plain = createDeck({
        storage: new Mapish(),
        deps: { createRunner: (o) => famEmitRunner(o, newRec(), 3) },
      })
      plain.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
      expect(await plain.startBot('bot-0')).toBe(true)
      expect(plain.globalHourCount).toBe(null)
      plain.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('全局闸满 → onGlobalTick 闲置发起整体跳过；跨整点滚动后下一班车恢复', async () => {
    vi.useFakeTimers()
    try {
      const rec = newRec()
      let t = at('12:00')
      let gateSeen = null
      const deck = createDeck({
        storage: new Mapish(),
        now: () => t,
        schedule: { globalHourlyMessages: 1 },
        deps: {
          createRunner: (o) => { gateSeen = o.gate; return famEmitRunner(o, rec, 1) },
          createScheduler: scriptedScheduler(rec),
        },
      })
      deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
      expect(await deck.startBot('bot-0')).toBe(true) // 上线即发 1 条 → 预算满
      expect(deck.globalHourCount).toBe(1)
      vi.advanceTimersByTime(HEARTBEAT_MS * 3)
      t += HEARTBEAT_MS * 3
      expect(rec.ticks).toEqual([]) // 满闸：调度器连 tick 都不被问（rng 零消耗）
      expect(rec.pokes).toEqual([])
      expect(gateSeen.allowSpeak(true)).toBe(false) // 满闸在 deck 层同样压住点名
      t += HOUR_MS + 1
      vi.advanceTimersByTime(HEARTBEAT_MS * 2) // 推进注入 now 后搭下一班车
      expect(rec.ticks.length).toBeGreaterThan(0) // 滚动归零 → 自动恢复发起
      expect(rec.pokes.length).toBeGreaterThan(0)
      expect(deck.globalHourCount).toBe(0)
      deck.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Task 7 读面契约：store.globalHourCount 是 getter——配置后为数字、未配置为 null', async () => {
    const deck = createDeck({
      storage: new Mapish(),
      schedule: { globalHourlyMessages: 9 },
      deps: { createRunner: (o) => famEmitRunner(o, newRec(), 2) },
    })
    expect('globalHourCount' in deck).toBe(true) // 属性面（Task 7 直接读，不是方法调用）
    expect(deck.globalHourCount).toBe(0) // 配置了但没发过：0（区别于「没装」的 null）
    deck.addBot({ id: 'bot-0', name: '小李', roomId: 'nebula' })
    await deck.startBot('bot-0')
    expect(deck.globalHourCount).toBe(2)
    expect(typeof deck.globalHourCount).toBe('number')
    deck.dispose()
  })
})

// —— R24（Task 3b）：每 bot 小时预算 hourlyBudget 进 deck 生命周期三面 ——
// normalizeCfg（保留语义：缺失/非有限 → **不设该键**，null 也是「缺失」——R17 pick
// undefined→null 陷阱）、persist 往返（加性字段：SCHEMA_VERSION 保持 1，老载荷照读）、
// makeRunnerOpts 快照（runner 拿到的 bot 形状，即「params 当且仅当」的上游入料面）。
describe('R24 hourlyBudget：normalizeCfg / persist 往返 / runner 快照', () => {
  it('normalizeCfg：配了（含 0）原样保留；缺失或 null/NaN/字符串 → 不设该键——「未配」与「0」可区分', () => {
    const deck = createDeck({ storage: new Mapish() })
    deck.addBot({ id: 'b1', name: 'A', roomId: 'nebula', hourlyBudget: 20 })
    expect(deck.bots[0].hourlyBudget).toBe(20)
    deck.addBot({ id: 'b2', name: 'B', roomId: 'nebula' })
    expect('hourlyBudget' in deck.bots[1]).toBe(false)
    deck.addBot({ id: 'b3', name: 'C', roomId: 'nebula', hourlyBudget: 0 })
    expect(deck.bots[2].hourlyBudget).toBe(0) // 0 合法：这条 bot 除点名外一条不发
    deck.addBot({ id: 'b4', name: 'D', roomId: 'nebula', hourlyBudget: null })
    expect('hourlyBudget' in deck.bots[3]).toBe(false) // null 是「未配」不是 0（Number(null)=0 的 JS 陷阱）
    deck.addBot({ id: 'b5', name: 'E', roomId: 'nebula', hourlyBudget: '20' })
    expect('hourlyBudget' in deck.bots[4]).toBe(false) // 非有限值（字符串）不入库
    expect(deck.bots.length).toBe(5) // MAX_BOTS=5 恰好容下，本用例不越界
  })

  it('persist 往返：带 hourlyBudget 的 bot 重载后仍在；未配的读回是「未设」不是 0；老载荷缺键照常载入（SCHEMA_VERSION 保持 1）', () => {
    const storage = new Mapish()
    const d1 = createDeck({ storage })
    d1.addProvider({ id: 'p1', name: 'DS', baseUrl: 'https://x.example', apiKey: 'sk-t' })
    d1.addBot({ id: 'b1', name: 'A', roomId: 'nebula', providerId: 'p1', hourlyBudget: 20 })
    d1.addBot({ id: 'b2', name: 'B', roomId: 'nebula', providerId: 'p1' })
    d1.addBot({ id: 'b3', name: 'C', roomId: 'nebula', providerId: 'p1', hourlyBudget: 0 })
    expect(SCHEMA_VERSION).toBe(1) // 加性可选字段——schema 不 bump（本任务红线）
    const payload = JSON.parse(storage.getItem(CONFIG_KEY))
    expect(payload.version).toBe(1)
    expect(payload.bots[0].hourlyBudget).toBe(20)
    expect(payload.bots[1].hourlyBudget).toBeNull() // pick 的 undefined→null 序列化形状（R17）
    expect(payload.bots[2].hourlyBudget).toBe(0)
    const d2 = createDeck({ storage }) // 从盘重载入
    expect(d2.bots[0].hourlyBudget).toBe(20)
    expect('hourlyBudget' in d2.bots[1]).toBe(false) // null 读回「未设」——与 0 分流
    expect(d2.bots[2].hourlyBudget).toBe(0)
    // 本任务之前写盘的老载荷：bots 条目完全不含 hourlyBudget 键
    storage.setItem(CONFIG_KEY, JSON.stringify({
      version: 1,
      providers: [{ id: 'p1', name: 'DS', baseUrl: 'https://x.example', apiKey: 'sk-t' }],
      bots: [{ id: 'b1', name: '小李', persona: 'p', chattiness: 50, providerId: 'p1', model: 'm', temperature: 0.9, rawPrompt: '', roomId: 'nebula', nick: null }],
      lifetime: {},
    }))
    const d3 = createDeck({ storage })
    expect(d3.bots.length).toBe(1) // 老载荷照常载入，不因新字段被拒
    expect('hourlyBudget' in d3.bots[0]).toBe(false) // 老 bot = 未配 = 缺省 cap 30
    expect(d3.bots[0].name).toBe('小李')
  })

  it('makeRunnerOpts 快照：hourlyBudget=20/0 原样进 bot 快照、未配为 null——runner 侧「有没有」与「是不是 0」在入料处即可判', async () => {
    const snaps = []
    const deck = createDeck({
      storage: new Mapish(),
      deps: { createRunner: (o) => { snaps.push(o.bot); return fakeRunner() } },
    })
    deck.addBot({ id: 'b1', name: 'A', roomId: 'nebula', hourlyBudget: 20 })
    deck.addBot({ id: 'b2', name: 'B', roomId: 'nebula' })
    deck.addBot({ id: 'b3', name: 'C', roomId: 'nebula', hourlyBudget: 0 })
    expect(await deck.startBot('b1')).toBe(true)
    expect(await deck.startBot('b2')).toBe(true)
    expect(await deck.startBot('b3')).toBe(true)
    expect(snaps[0].hourlyBudget).toBe(20)
    expect(snaps[1].hourlyBudget).toBe(null) // pick 归一空——Number.isFinite(null)=false → 不覆盖 hourlyCap
    expect(snaps[2].hourlyBudget).toBe(0) // 0 不被 null 化——Number.isFinite(0)=true → hourlyCap=0
    deck.dispose()
  })
})
