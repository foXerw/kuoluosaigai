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
})
