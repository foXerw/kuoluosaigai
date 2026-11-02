// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createNullLease } from 'kuoluosaigai-bot-core'

// Mapish —— createTabLease 的 storage 注入契约就是 {getItem,setItem,removeItem}
// 三个方法（见 src/bots/lease.js），这里自建一个 Map 封装，不引新测试依赖。
class Mapish {
  #map = new Map()
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null }
  setItem(k, v) { this.#map.set(k, String(v)) }
  removeItem(k) { this.#map.delete(k) }
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
