// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createNullLease, createDeck } from 'kuoluosaigai-bot-core'

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
