import { describe, it, expect, vi } from 'vitest'
import {
  createTabLease,
  LEASE_KEY,
  HEARTBEAT_MS,
  STALE_MS,
  RECHECK_MS,
} from '../src/bots/lease'

// Task 6 / spec §11「tabLease」矩阵：常量导出 / acquire / heartbeat / release /
// releaseAll / isHeldElsewhere / degraded / B20 竞态复查 / 死租约接管 / 坏 JSON / 存储降级。
// tabId、now、sleep、storage 全部注入，保证确定性。

const TAB_A = 'tab-A'
const TAB_B = 'tab-B'
const BOT_1 = 'bot-1'

/** 简易 Map 包装器，模拟 localStorage 行为。 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((k) => map.get(k) ?? null),
    setItem: vi.fn((k, v) => map.set(k, v)),
    removeItem: vi.fn((k) => map.delete(k)),
    _map: map,
  }
}

describe('constants', () => {
  it('导出正确的常量值', () => {
    expect(LEASE_KEY).toBe('kuoluosaigai:bots:lease')
    expect(HEARTBEAT_MS).toBe(15000)
    expect(STALE_MS).toBe(60000)
    expect(RECHECK_MS).toBe(150)
  })
})

describe('createTabLease — acquire 空闲 bot', () => {
  it('acquire 空闲 bot → true 且写入 {tabId, ts}', () => {
    const storage = makeStorage()
    const nowVal = 1000
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => nowVal, sleep })
    const result = lease.acquire(BOT_1)
    // acquire 是 async——但 sleep 注入的是立即 resolve，所以 microtask 排队
    // 用 .then 捕获结果
    return expect(result).resolves.toBe(true)
      .then(() => {
        expect(storage.setItem).toHaveBeenCalledWith(
          LEASE_KEY,
          JSON.stringify({ [BOT_1]: { tabId: TAB_A, ts: nowVal } })
        )
      })
  })

  it('heartbeat 刷新 ts', () => {
    const storage = makeStorage()
    let nowVal = 1000
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => nowVal, sleep })

    return lease.acquire(BOT_1)
      .then(() => {
        nowVal = 5000
        lease.heartbeat(BOT_1)
        // heartbeat 是同步的，直接读 storage
        const table = JSON.parse(storage._map.get(LEASE_KEY))
        expect(table[BOT_1].ts).toBe(5000)
      })
  })

  it('重复 acquire 同一 bot（已是本 tab）→ true 且更新 ts', () => {
    const storage = makeStorage()
    let nowVal = 1000
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => nowVal, sleep })

    return lease.acquire(BOT_1)
      .then((r1) => {
        expect(r1).toBe(true)
        nowVal = 2000
        return lease.acquire(BOT_1)
      })
      .then((r2) => {
        expect(r2).toBe(true)
        const table = JSON.parse(storage._map.get(LEASE_KEY))
        expect(table[BOT_1].ts).toBe(2000)
      })
  })
})

describe('他 tab 新鲜租约', () => {
  it('acquire 返回 false、不写 storage、不进入复查 sleep（不写直接 false）', () => {
    const storage = makeStorage()
    const existing = JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: 900 } })
    storage._map.set(LEASE_KEY, existing)
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000, sleep })
    return expect(lease.acquire(BOT_1)).resolves.toBe(false)
      .then(() => {
        expect(storage.setItem).not.toHaveBeenCalled()
        expect(sleep).not.toHaveBeenCalled()
        expect(storage._map.get(LEASE_KEY)).toBe(existing)
      })
  })

  it('isHeldElsewhere → true', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: 900 } }))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 })
    expect(lease.isHeldElsewhere(BOT_1)).toBe(true)
  })
})

describe('死租约接管', () => {
  it('ts 差 ≥ STALE_MS → acquire true 并覆盖', () => {
    const storage = makeStorage()
    const oldTs = 1000
    const currentTs = oldTs + STALE_MS + 1
    storage._map.set(LEASE_KEY, JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: oldTs } }))
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => currentTs, sleep })
    return expect(lease.acquire(BOT_1)).resolves.toBe(true)
      .then(() => {
        const table = JSON.parse(storage._map.get(LEASE_KEY))
        expect(table[BOT_1].tabId).toBe(TAB_A)
        expect(table[BOT_1].ts).toBe(currentTs)
      })
  })

  it('死租约时 isHeldElsewhere → false（因为陈旧不算有效持有）', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: 1000 } }))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 + STALE_MS + 1 })
    expect(lease.isHeldElsewhere(BOT_1)).toBe(false)
  })
})

describe('B20: 竞态复查 — acquire 写入后 sleep(150) 复查发现 holder 变了', () => {
  it('写入后复查时发现 holder 变成他 tab（新鲜）→ 返回 false', () => {
    const storage = makeStorage()
    const sleep = vi.fn(async () => {
      // sleep 执行期间：测试代码篡改 storage 里的 holder
      storage._map.set(LEASE_KEY, JSON.stringify({
        [BOT_1]: { tabId: TAB_B, ts: 1000 },
      }))
    })
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000, sleep })
    return expect(lease.acquire(BOT_1)).resolves.toBe(false)
  })
})

describe('release / releaseAll', () => {
  it('release 清除本 tab 条目、不动他 tab 条目', () => {
    const storage = makeStorage()
    const table = {
      [BOT_1]: { tabId: TAB_A, ts: 1000 },
      [BOT_1 + '-other']: { tabId: TAB_B, ts: 1000 },
    }
    storage._map.set(LEASE_KEY, JSON.stringify(table))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 })
    lease.release(BOT_1)
    const updated = JSON.parse(storage._map.get(LEASE_KEY))
    expect(updated[BOT_1]).toBeUndefined()
    expect(updated[BOT_1 + '-other']).toEqual({ tabId: TAB_B, ts: 1000 })
  })

  it('release 对他 tab 的条目不做任何事', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: 1000 } }))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 })
    lease.release(BOT_1)
    const updated = JSON.parse(storage._map.get(LEASE_KEY))
    expect(updated[BOT_1]).toEqual({ tabId: TAB_B, ts: 1000 })
  })

  it('releaseAll 清所有本 tab 条目', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, JSON.stringify({
      [BOT_1]: { tabId: TAB_A, ts: 1000 },
      [BOT_1 + '-b']: { tabId: TAB_B, ts: 1000 },
      [BOT_1 + '-a2']: { tabId: TAB_A, ts: 2000 },
    }))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 })
    lease.releaseAll()
    const updated = JSON.parse(storage._map.get(LEASE_KEY))
    expect(updated[BOT_1]).toBeUndefined()
    expect(updated[BOT_1 + '-b']).toEqual({ tabId: TAB_B, ts: 1000 })
    expect(updated[BOT_1 + '-a2']).toBeUndefined()
  })
})

describe('storage 抛异常降级', () => {
  it('读抛错 → degraded=true，acquire 仍 true（互斥降级），isHeldElsewhere=false', () => {
    const storage = makeStorage()
    storage.getItem.mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000, sleep })
    // 先触发一次读操作使 degraded 变为 true
    const acResult = lease.acquire(BOT_1)
    return expect(acResult).resolves.toBe(true)
      .then(() => {
        expect(lease.degraded).toBe(true)
        expect(lease.isHeldElsewhere(BOT_1)).toBe(false)
      })
  })

  it('写抛错也置 degraded=true，但 acquire 不阻断', () => {
    const storage = makeStorage()
    let callCount = 0
    storage.setItem.mockImplementation(() => {
      callCount++
      if (callCount === 1) throw new DOMException('Write failed', 'InvalidStateError')
    })
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000, sleep })
    return expect(lease.acquire(BOT_1)).resolves.toBe(true)
      .then(() => {
        expect(lease.degraded).toBe(true)
      })
  })
})

describe('租约值为坏 JSON', () => {
  it('bad JSON 视为空表重建，acquire 正常写入', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, 'not-valid-json{{{')
    const sleep = vi.fn(() => Promise.resolve())
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000, sleep })
    // 坏 JSON 不算他 tab 持有
    expect(lease.isHeldElsewhere(BOT_1)).toBe(false)
    return expect(lease.acquire(BOT_1)).resolves.toBe(true)
      .then(() => {
        const table = JSON.parse(storage._map.get(LEASE_KEY))
        expect(table[BOT_1]).toEqual({ tabId: TAB_A, ts: 1000 })
      })
  })
})

describe('heartbeat 边缘情况', () => {
  it('心跳条目不存在则不写', () => {
    const storage = makeStorage()
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 1000 })
    lease.heartbeat(BOT_1)
    // setItem 不应该被调用
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('心跳他 tab 的条目不写（易主检测）', () => {
    const storage = makeStorage()
    storage._map.set(LEASE_KEY, JSON.stringify({ [BOT_1]: { tabId: TAB_B, ts: 1000 } }))
    const lease = createTabLease({ storage, tabId: TAB_A, now: () => 2000 })
    lease.heartbeat(BOT_1)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
