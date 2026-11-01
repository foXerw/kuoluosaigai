import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createBotStore,
  CONFIG_KEY,
  SCHEMA_VERSION,
  MAX_BOTS,
  PROVIDER_PRESETS,
} from '../src/bots/store'
import { createIdleScheduler } from '../src/bots/rhythm'
import { createTabLease, LEASE_KEY, STALE_MS } from '../src/bots/lease'

// Task 8 / spec §11「botStore」矩阵 + Review Focus 3/5：持久化 roundtrip（B15）、
// 写失败降级（B17）、MAX_BOTS、租约互斥（B20 端到端）、闲置调度缝合、家族 nick、
// getOwnerNick、lifetime 累计节流、dispose 生命周期（B12）。
// runner/lease/scheduler 经 deps 构造注入（优先）；now/rng 注入保证确定性。

function makeMemStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((k) => (map.has(k) ? map.get(k) : null)),
    setItem: vi.fn((k, v) => { map.set(k, String(v)) }),
    removeItem: vi.fn((k) => { map.delete(k) }),
    _map: map,
  }
}

// 简化租约桩：写入后微任务复查 holder，保留 B20「恰一个成功」的竞态本质；
// 纯微任务、零定时器，fake timers 下无死锁。
function makeLeaseStub(tabId, table) {
  const calls = { acquire: [], heartbeat: [], release: [], releaseAll: 0 }
  const lease = {
    async acquire(id) {
      calls.acquire.push(id)
      const holder = table[id]
      if (holder && holder !== tabId) return false
      table[id] = tabId
      await null
      return table[id] === tabId
    },
    release(id) {
      calls.release.push(id)
      if (table[id] === tabId) delete table[id]
    },
    releaseAll() {
      calls.releaseAll += 1
      for (const k of Object.keys(table)) if (table[k] === tabId) delete table[k]
    },
    heartbeat(id) { calls.heartbeat.push(id) },
    isHeldElsewhere(id) { return !!table[id] && table[id] !== tabId },
    degraded: false,
  }
  return { lease, calls }
}

// 审查轮 1 Finding #3：acquire 挂起在手动开闸的 Promise 上，制造 await 窗口竞态
function makeGatedLease(tabId, table) {
  const calls = { acquire: [], heartbeat: [], release: [], releaseAll: 0 }
  let gate = null
  const lease = {
    acquire(id) {
      calls.acquire.push(id)
      return new Promise((resolve) => {
        gate = { resolve: (v) => { if (v) table[id] = tabId; resolve(v) } }
      })
    },
    release(id) {
      calls.release.push(id)
      if (table[id] === tabId) delete table[id]
    },
    releaseAll() {
      calls.releaseAll += 1
      for (const k of Object.keys(table)) if (table[k] === tabId) delete table[k]
    },
    heartbeat(id) { calls.heartbeat.push(id) },
    isHeldElsewhere(id) { return !!table[id] && table[id] !== tabId },
    degraded: false,
  }
  return { lease, calls, openGate: (v) => { const g = gate; gate = null; g.resolve(v) } }
}

function makeRunnerStub() {
  const all = []
  const byBot = new Map()
  const factory = (opts) => {
    const r = {
      opts,
      botId: opts.bot.id,
      startCalls: 0,
      stopReasons: [],
      pokes: 0,
      pokeOpts: [],
      eligibleCalls: 0,
      rollCalls: 0,
      switches: [],
      clearCalls: 0,
      buffer: [{ id: 'f1', nick: 'ANON-X', text: 'hello', roomId: opts.bot.roomId }],
      start() { r.startCalls += 1 },
      stop(reason) {
        r.stopReasons.push(reason === undefined ? null : reason)
        opts.onEvent && opts.onEvent('stopped', reason === undefined ? null : reason)
      },
      switchRoom(roomId) { r.switches.push(roomId) },
      clearBuffer() { r.clearCalls += 1; r.buffer = [] },
      getBuffer() { return r.buffer },
      pokeIdle(o) { r.pokes += 1; r.pokeOpts.push(o === undefined ? null : o) },
      idleEligible() { r.eligibleCalls += 1; return r._eligible ? r._eligible() : true },
      idleRoll() { r.rollCalls += 1; return r._roll ? r._roll() : true },
      getState() { return { status: 'fake', started: r.startCalls > 0 } },
    }
    all.push(r)
    byBot.set(opts.bot.id, r)
    return r
  }
  return { factory, all, byBot }
}

function defaultScheduler(opts) {
  return createIdleScheduler(opts) // 默认窗口 ≥180s，单测里除非刻意推进很久否则不会触发
}

function setup(over = {}) {
  let t = 0
  const now = () => t
  const advance = (ms) => { t += ms; vi.advanceTimersByTime(ms) }
  const storage = over.storage || makeMemStorage()
  const ss = over.ss || makeMemStorage()
  const table = over.table || {}
  const leaseStub = over.leaseStub || makeLeaseStub(over.tabId || 'tab-A', table)
  const runnerStub = makeRunnerStub()
  const store = createBotStore({
    wsUrl: 'ws://test',
    storage,
    sessionStorage: ss,
    rng: over.rng || (() => 0.5),
    now,
    deps: {
      createLease: () => leaseStub.lease,
      createRunner: runnerStub.factory,
      createScheduler: over.createScheduler || defaultScheduler,
    },
  })
  return { store, advance, now: () => t, storage, ss, table, leaseStub, runnerStub }
}

// 纯配置 roundtrip 用（不起定时器、不启动）
function mkStore(storage) {
  return createBotStore({
    wsUrl: 'ws://test',
    storage,
    sessionStorage: makeMemStorage(),
    rng: () => 0.5,
    now: () => 0,
    deps: {
      createLease: () => makeLeaseStub('t', {}).lease,
      createRunner: makeRunnerStub().factory,
      createScheduler: defaultScheduler,
    },
  })
}

function seedPayload() {
  return {
    version: 1,
    providers: [{ id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' }],
    bots: [{
      id: 'b1', name: '小探', persona: 'p', chattiness: 60, providerId: 'p1',
      model: 'deepseek-chat', temperature: 0.8, rawPrompt: '', roomId: '42', nick: 'ANON-7K2Q',
    }],
    lifetime: { b1: { promptTokens: 1200, completionTokens: 300 } },
  }
}

const CFG = { name: 'n', persona: '', chattiness: 50, providerId: 'p1', model: 'm', temperature: 0.7, rawPrompt: '', roomId: 'room-a' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('botStore 常量', () => {
  it('导出钉死的 CONFIG_KEY/SCHEMA_VERSION/MAX_BOTS/PROVIDER_PRESETS', () => {
    expect(CONFIG_KEY).toBe('kuoluosaigai:bots:v1')
    expect(SCHEMA_VERSION).toBe(1)
    expect(MAX_BOTS).toBe(5)
    expect(PROVIDER_PRESETS).toEqual([
      { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
      { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
      { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    ])
  })
})

describe('load/persist', () => {
  it('load: 合法载荷 roundtrip（providers/bots/lifetime 恢复）；version≠1 或坏 JSON → 全部重建为空且不抛（B15）', () => {
    // 合法载荷恢复
    const storage = makeMemStorage({ [CONFIG_KEY]: JSON.stringify(seedPayload()) })
    const store = mkStore(storage)
    expect(store.providers.length).toBe(1)
    expect(store.providers[0].apiKey).toBe('sk-1')
    expect(store.bots.length).toBe(1)
    expect(store.bots[0].name).toBe('小探')
    expect(store.bots[0].rt.nick).toBe('ANON-7K2Q') // 身份跨刷新延续
    expect(store.bots[0].rt.status).toBe('stopped')
    expect(store.lifetime.b1).toEqual({ promptTokens: 1200, completionTokens: 300 })

    // addBot（name>12 截断）→ persist 载荷不含 rt → 重载 store 完成 roundtrip
    expect(store.addBot({ id: 'b2', name: '一二三四五六七八九十一二三', roomId: 'r2' })).toEqual({ ok: true })
    expect(store.bots[1].name.length).toBe(12)
    const raw = JSON.parse(storage._map.get(CONFIG_KEY))
    expect(raw.version).toBe(1)
    expect(raw.bots.length).toBe(2)
    expect(raw.bots[0].rt).toBeUndefined()
    expect(raw.bots[0].nick).toBe('ANON-7K2Q')
    // store.persist()/store.load() 公开方法可用（Task 9/10 会直接调）
    const writesBefore = storage.setItem.mock.calls.filter((c) => c[0] === CONFIG_KEY).length
    store.persist()
    expect(storage.setItem.mock.calls.filter((c) => c[0] === CONFIG_KEY).length).toBe(writesBefore + 1)
    store.load()
    expect(store.bots.length).toBe(2)
    expect(store.providers.length).toBe(1)

    const store2 = mkStore(storage)
    expect(store2.bots.length).toBe(2)
    expect(store2.bots[1].name.length).toBe(12)
    expect(store2.lifetime.b1).toEqual({ promptTokens: 1200, completionTokens: 300 })

    // 坏 JSON → 全部重建为空且不抛
    const bad = makeMemStorage({ [CONFIG_KEY]: '{oops' })
    let s2
    expect(() => { s2 = mkStore(bad) }).not.toThrow()
    expect(s2.bots.length).toBe(0)
    expect(s2.providers.length).toBe(0)

    // version≠1 → 同样重建为空
    const v2 = makeMemStorage({ [CONFIG_KEY]: JSON.stringify({ ...seedPayload(), version: 2 }) })
    let s3
    expect(() => { s3 = mkStore(v2) }).not.toThrow()
    expect(s3.bots.length).toBe(0)
    expect(s3.providers.length).toBe(0)
    expect(s3.lifetime).toEqual({})
  })

  it('persist 写失败（storage.setItem 抛）→ storageDegraded=true，内存状态照常可用（B17）', async () => {
    const storage = makeMemStorage()
    storage.setItem = () => { throw new Error('QuotaExceeded') }
    const store = createBotStore({
      wsUrl: 'ws://test',
      storage,
      sessionStorage: makeMemStorage(),
      rng: () => 0.5,
      now: () => 0,
      deps: {
        createLease: () => makeLeaseStub('t', {}).lease,
        createRunner: makeRunnerStub().factory,
        createScheduler: defaultScheduler,
      },
    })
    expect(store.storageDegraded).toBe(false)
    expect(() => store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })).not.toThrow()
    expect(store.storageDegraded).toBe(true)
    expect(store.providers.length).toBe(1)
    expect(store.addBot({ id: 'b1', ...CFG })).toEqual({ ok: true })
    expect(store.bots.length).toBe(1)
    await expect(store.startBot('b1')).resolves.toBe(true) // 仅内存模式照常可启动
  })
})

describe('addBot', () => {
  it('addBot 第 6 个 → {error:"MAX_BOTS"}', () => {
    const { store } = setup()
    for (let i = 0; i < MAX_BOTS; i++) {
      expect(store.addBot({ id: `b${i}`, ...CFG })).toEqual({ ok: true })
    }
    expect(store.addBot({ id: 'b-extra', ...CFG })).toEqual({ error: 'MAX_BOTS' })
    expect(store.bots.length).toBe(MAX_BOTS)
  })
})

describe('startBot 租约互斥', () => {
  it('startBot: 租约被他 tab 持有 → false 且 rt.otherTab=true；正常 → runner.start 被调、心跳定时器启动', async () => {
    // (a) 他 tab 新鲜持有
    const a = setup({ table: { b1: 'tab-X' } })
    a.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    a.store.addBot({ id: 'b1', ...CFG })
    await expect(a.store.startBot('b1')).resolves.toBe(false)
    expect(a.store.bots[0].rt.otherTab).toBe(true)
    expect(a.runnerStub.all.length).toBe(0)
    a.advance(15000)
    expect(a.leaseStub.calls.heartbeat.length).toBe(0)

    // (b) 正常：acquire 成功 → runner.start + 每 15s 心跳
    const b = setup()
    b.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    b.store.addBot({ id: 'b1', ...CFG })
    await expect(b.store.startBot('b1')).resolves.toBe(true)
    expect(b.runnerStub.byBot.get('b1').startCalls).toBe(1)
    expect(b.store.bots[0].rt.otherTab).toBe(false)
    expect(b.leaseStub.calls.heartbeat.length).toBe(0)
    b.advance(15000)
    expect(b.leaseStub.calls.heartbeat).toEqual(['b1'])
    b.advance(15000)
    expect(b.leaseStub.calls.heartbeat).toEqual(['b1', 'b1'])
  })

  it('removeBot 运行中先 stop：runner 停、租约释放、lifetime 与配置项清除', async () => {
    const h = setup()
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    await h.store.startBot('b1')
    const r = h.runnerStub.byBot.get('b1')
    r.opts.onState({ rev: 1, session: { promptTokens: 7, completionTokens: 3, messages: 1 } })
    expect(h.store.removeBot('b1')).toBe(true)
    expect(r.stopReasons.length).toBe(1) // 运行中先 stop
    expect(h.leaseStub.calls.release).toContain('b1')
    expect(h.table.b1).toBeUndefined()
    expect(h.store.bots.length).toBe(0)
    expect(h.store.lifetime.b1).toBeUndefined()
    const raw = JSON.parse(h.storage._map.get(CONFIG_KEY))
    expect(raw.bots.length).toBe(0)
    expect(raw.lifetime).toEqual({})
    h.advance(30000) // 无幽灵心跳
    expect(h.leaseStub.calls.heartbeat.length).toBe(0)
  })

  it('双 store 实例（模拟两 tab，共享同一 mock storage）同时 startBot → 恰好一个成功（B20 端到端）', async () => {
    const table = {}
    const runnerStub = makeRunnerStub()
    const mk = (tabId) => createBotStore({
      wsUrl: 'ws://test',
      storage: makeMemStorage(),
      sessionStorage: makeMemStorage(),
      rng: () => 0.5,
      now: () => 0,
      deps: {
        createLease: () => makeLeaseStub(tabId, table).lease,
        createRunner: runnerStub.factory,
        createScheduler: defaultScheduler,
      },
    })
    const storeA = mk('tab-A')
    const storeB = mk('tab-B')
    for (const s of [storeA, storeB]) {
      s.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
      s.addBot({ id: 'b1', ...CFG })
    }
    const [okA, okB] = await Promise.all([storeA.startBot('b1'), storeB.startBot('b1')])
    expect([okA, okB].filter(Boolean).length).toBe(1)
    expect(table.b1).toBeTruthy()
    expect(runnerStub.all.length).toBe(1) // 败者不建 runner
    const loser = okA ? storeB : storeA
    expect(loser.bots[0].rt.otherTab).toBe(true)
  })

  it('B20 端到端·真租约（审查轮 1 #2）：两 store 共享同一 mock storage + 真 createTabLease，并发 startBot → 恰一个成功', async () => {
    const storage = makeMemStorage() // 两 tab 真正共享的 localStorage
    const runnerStub = makeRunnerStub()
    const mk = (tabId) => createBotStore({
      wsUrl: 'ws://test',
      storage,
      sessionStorage: makeMemStorage(),
      rng: () => 0.5,
      now: () => 0,
      deps: {
        createLease: (o) => createTabLease({ ...o, tabId }), // 真 lease，仅 RECHECK sleep 立即化
        createRunner: runnerStub.factory,
        createScheduler: defaultScheduler,
        sleep: () => Promise.resolve(),
      },
    })
    const storeA = mk('tab-A')
    const storeB = mk('tab-B')
    for (const s of [storeA, storeB]) {
      s.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
      s.addBot({ id: 'b1', ...CFG })
    }
    const [okA, okB] = await Promise.all([storeA.startBot('b1'), storeB.startBot('b1')])
    expect([okA, okB].filter(Boolean).length).toBe(1)
    expect(okA).toBe(true) // A 先写 holder，B 见新鲜他人条目 → 立即 false
    expect(okB).toBe(false)
    expect(storeA.bots[0].rt.otherTab).toBe(false)
    expect(storeB.bots[0].rt.otherTab).toBe(true)
    expect(runnerStub.all.length).toBe(1)
    const leaseTable = JSON.parse(storage._map.get(LEASE_KEY))
    expect(leaseTable.b1.tabId).toBe('tab-A')
  })

  it('startBot 竞态守卫（审查轮 1 #3）：acquire 等待窗口内 removeBot → 不产出幽灵 runner，已取得的租约归还', async () => {
    const table = {}
    const gated = makeGatedLease('tab-A', table)
    const h = setup({ leaseStub: gated })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    const p = h.store.startBot('b1') // 挂在 acquire 上
    expect(h.runnerStub.all.length).toBe(0)
    h.store.removeBot('b1') // 窗口期删除配置
    gated.openGate(true) // 随后才取得租约
    await expect(p).resolves.toBe(false)
    expect(h.runnerStub.all.length).toBe(0) // 幽灵 runner 不得出现
    expect(table.b1).toBeUndefined() // 取得即归还
    expect(gated.calls.release).toContain('b1')
  })

  it('startBot 竞态守卫（审查轮 1 #3）：acquire 等待窗口内 stopBot → start 作废且租约归还，不静默复活', async () => {
    const table = {}
    const gated = makeGatedLease('tab-A', table)
    const h = setup({ leaseStub: gated })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    const p = h.store.startBot('b1')
    h.store.stopBot('b1') // 窗口期用户点停
    gated.openGate(true)
    await expect(p).resolves.toBe(false)
    expect(h.runnerStub.all.length).toBe(0)
    expect(table.b1).toBeUndefined()
    expect(gated.calls.release).toContain('b1')
    expect(h.store.bots[0].rt.status).toBe('stopped')
  })
})

describe('闲置调度', () => {
  it('15000ms interval tick → 房内运行 bot 作为 candidates；winner → 对应 runner.pokeIdle；runner onEvent("activity") 重置该房窗口；bot 全部停止的房间调度器被回收', async () => {
    const made = []
    const createScheduler = (opts) => {
      const real = createIdleScheduler({
        ...opts,
        // 收紧窗口让调度在测试时间线内可观察（[lo==hi] + 常量 rng → 完全确定）
        params: { idleWindowAfterChatMs: [10000, 10000], idleWindowAfterIdleMs: [400000, 400000] },
      })
      const rec = {
        ticks: [], notifies: 0,
        notifyActivity() { rec.notifies += 1; real.notifyActivity() },
        tick(cands) { rec.ticks.push(cands.map((c) => c.id)); return real.tick(cands) },
      }
      made.push(rec)
      return rec
    }
    const h = setup({ createScheduler })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    await h.store.startBot('b1') // t=0：room-a 调度器创建（窗口 10000）
    const r1 = h.runnerStub.byBot.get('b1')
    r1.opts.onState({ rev: 1, status: 'open', nick: 'ANON-1' })

    h.advance(15000) // tick1：窗口到期 → 候选 = 房内运行 bot → winner → pokeIdle
    expect(made[0].ticks[0]).toEqual(['b1'])
    expect(r1.pokes).toBe(1)
    expect(r1.pokeOpts[0]).toEqual({ preRolled: true }) // 真骰子在 candidates（审查轮 1 #1）
    expect(r1.eligibleCalls).toBeGreaterThan(0) // 门禁经 runner.idleEligible 代理

    h.advance(15000) // tick2：afterIdle 窗口未到 → 不再 poke
    expect(r1.pokes).toBe(1)

    r1.opts.onEvent('activity', { roomId: 'room-a' }) // t=30000：重置为 afterChat（40000 到期）
    expect(made[0].notifies).toBe(1)
    h.advance(15000) // t=45000 ≥ 40000 → 再次 poke（证明 activity 重置了窗口）
    expect(r1.pokes).toBe(2)

    h.store.stopBot('b1') // 房内无运行 bot → 调度器回收 + interval 停
    const ticksAtStop = made[0].ticks.length
    h.advance(30000)
    expect(made[0].ticks.length).toBe(ticksAtStop)
    expect(r1.pokes).toBe(2)

    await h.store.startBot('b1') // 重启 → room-a 新建调度器（回收的没被复用）
    expect(made.length).toBe(2)
    const r2 = h.runnerStub.byBot.get('b1')
    r2.opts.onState({ rev: 1, status: 'open', nick: 'ANON-1' })
    h.store.switchBotRoom('b1', 'room-b')
    expect(r2.switches).toEqual(['room-b'])
    expect(h.store.bots[0].roomId).toBe('room-b')
    h.advance(15000) // t=90000：room-a 调度器因切房被回收（未 tick 过），room-b 懒建（窗口 100000）
    expect(made.length).toBe(3)
    expect(made[1].ticks.length).toBe(0)
    expect(made[2].ticks[0]).toEqual(['b1'])
    expect(r2.pokes).toBe(0)
    h.advance(15000) // t=105000 ≥ 100000 → 新房 winner
    expect(r2.pokes).toBe(1)
  })

  it('真骰子透传（审查轮 1 #1）：rollIdle 未中 → 全员未过短窗重开（不误记成功进长窗）；冷却 bot 不作 winner 且被短路不掷', async () => {
    const made = []
    const createScheduler = (opts) => {
      const real = createIdleScheduler({
        ...opts,
        params: { idleWindowAfterChatMs: [10000, 10000], idleWindowAfterIdleMs: [400000, 400000] },
      })
      const rec = {
        ticks: [],
        notifyActivity() { real.notifyActivity() },
        tick(cands) { rec.ticks.push(cands.map((c) => c.id)); return real.tick(cands) },
      }
      made.push(rec)
      return rec
    }
    const h = setup({ createScheduler })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    h.store.addBot({ id: 'b2', ...CFG, name: 'n2' }) // 同房
    await h.store.startBot('b1')
    await h.store.startBot('b2')
    const r1 = h.runnerStub.byBot.get('b1')
    const r2 = h.runnerStub.byBot.get('b2')
    r1.opts.onState({ rev: 1, status: 'open', nick: 'ANON-1' })
    r2.opts.onState({ rev: 1, status: 'open', nick: 'ANON-2' })

    // 全员未过：b1 冷却门禁假、b2 rollIdle 假 → 无 winner，且 b1 被短路根本不掷
    r1._eligible = () => false
    let b1RollAsked = false
    r1._roll = () => { b1RollAsked = true; return true }
    r2._roll = () => false
    h.advance(15000) // tick1（窗口 10000 已到期）
    expect(made[0].ticks[0]).toEqual(['b1', 'b2'])
    expect(b1RollAsked).toBe(false) // canInitiateIdle 不过 → 短路不掷（B21 门禁经 idleEligible）
    expect(r1.pokes).toBe(0)
    expect(r2.pokes).toBe(0)

    h.advance(15000) // tick2：全员未过按 afterChat 短窗重开（30000 前赴的是 25000 的短窗，不是 400000 长窗）
    expect(made[0].ticks.length).toBe(2)
    expect(r2.pokes).toBe(0)

    // b2 骰子改为命中 → tick3（45000 ≥ 40000）winner → pokeIdle({preRolled:true}) 直发
    r2._roll = () => true
    h.advance(15000)
    expect(r2.pokes).toBe(1)
    expect(r2.pokeOpts[0]).toEqual({ preRolled: true }) // 已问过 idleRoll，runner 不再二次掷
    expect(r1.pokes).toBe(0) // 冷却 bot 始终不作 winner
    h.advance(15000) // 成功发起后才是 afterIdle 长窗
    expect(r2.pokes).toBe(1)
  })
})

describe('家族 nick / owner nick', () => {
  it('家族 nick 集合 = 所有运行中 bot 的 rt.nick（含刚 assign 的），经 getFamilyNicks 传给 runner', async () => {
    const h = setup()
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    h.store.addBot({ id: 'b2', ...CFG, name: 'n2', roomId: 'room-b' })
    await h.store.startBot('b1')
    await h.store.startBot('b2')
    const r1 = h.runnerStub.byBot.get('b1')
    const r2 = h.runnerStub.byBot.get('b2')
    expect(r1.opts.getFamilyNicks()).toEqual([]) // 还没 assign → 空
    r1.opts.onState({ rev: 1, status: 'open', nick: 'ANON-1' })
    r2.opts.onState({ rev: 1, status: 'open', nick: 'ANON-2' }) // 刚 assign 即入集合
    expect(new Set(r1.opts.getFamilyNicks())).toEqual(new Set(['ANON-1', 'ANON-2']))
    expect(r2.opts.getFamilyNicks()).toContain('ANON-1')

    // onEvent('nick') 写回配置并持久化（身份跨刷新延续）
    r2.opts.onEvent('nick', { nick: 'ANON-2' })
    expect(h.store.bots[1].nick).toBe('ANON-2')
    const raw = JSON.parse(h.storage._map.get(CONFIG_KEY))
    expect(raw.bots[1].nick).toBe('ANON-2')

    h.store.stopBot('b2') // 停止后退出家族集合
    expect(r1.opts.getFamilyNicks()).toEqual(['ANON-1'])
  })

  it('getOwnerNick 读 sessionStorage["kuoluosaigai:nick"]', async () => {
    const h = setup()
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    h.ss.setItem('kuoluosaigai:nick', '主人')
    await h.store.startBot('b1')
    const r = h.runnerStub.byBot.get('b1')
    expect(r.opts.getOwnerNick()).toBe('主人')
    h.ss.removeItem('kuoluosaigai:nick')
    expect(r.opts.getOwnerNick()).toBeNull()

    // sessionStorage 读取抛异常 → null 不炸
    const badSs = { getItem: () => { throw new Error('boom') }, setItem: () => {}, removeItem: () => {} }
    const h2 = setup({ ss: badSs })
    h2.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h2.store.addBot({ id: 'b1', ...CFG })
    await h2.store.startBot('b1')
    expect(h2.runnerStub.byBot.get('b1').opts.getOwnerNick()).toBeNull()
  })
})

describe('lifetime 累计', () => {
  it('runner onState.session 变化时增量写 lifetime 并 persist（节流：至多每 10s 一次）', async () => {
    const h = setup()
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    const writes = () => h.storage.setItem.mock.calls.filter((c) => c[0] === CONFIG_KEY).length
    const w0 = writes() // addProvider + addBot 两次即时写

    await h.store.startBot('b1')
    const r = h.runnerStub.byBot.get('b1')
    r.opts.onState({ rev: 1, status: 'open', session: { promptTokens: 10, completionTokens: 2, messages: 1 } })
    expect(h.store.lifetime.b1).toEqual({ promptTokens: 10, completionTokens: 2 }) // 内存即时累计
    expect(writes()).toBe(w0) // 距上次 persist <10s → 节流未写

    r.opts.onState({ rev: 2, session: { promptTokens: 30, completionTokens: 5, messages: 2 } })
    expect(h.store.lifetime.b1).toEqual({ promptTokens: 30, completionTokens: 5 }) // 30-10=20 增量
    expect(h.store.bots[0].rt.session).toEqual({ promptTokens: 30, completionTokens: 5, messages: 2 })
    expect(writes()).toBe(w0) // 多次变化合并到同一个 trailing timer

    h.advance(10000) // trailing 到期 → 落盘一次
    expect(writes()).toBe(w0 + 1)
    expect(JSON.parse(h.storage._map.get(CONFIG_KEY)).lifetime.b1).toEqual({ promptTokens: 30, completionTokens: 5 })

    r.opts.onState({ rev: 3, session: { promptTokens: 60, completionTokens: 9, messages: 3 } })
    expect(writes()).toBe(w0 + 1) // 又进入新的 10s 节流窗口
    h.advance(10000)
    expect(writes()).toBe(w0 + 2)
    expect(h.store.lifetime.b1).toEqual({ promptTokens: 60, completionTokens: 9 })
  })
})

describe('dispose', () => {
  it('dispose: 停全部 runner + lease.releaseAll + 清 interval（B12 依赖此）', async () => {
    const table = { /* start 后写入 b1 */ }
    const h = setup({ table })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    await h.store.startBot('b1')
    const r = h.runnerStub.byBot.get('b1')
    h.advance(15000)
    expect(h.leaseStub.calls.heartbeat.length).toBe(1)

    r.opts.onState({ rev: 1, session: { promptTokens: 5, completionTokens: 1, messages: 1 } })
    h.store.dispose()

    expect(r.stopReasons.length).toBe(1) // 停全部 runner
    expect(h.leaseStub.calls.releaseAll).toBe(1)
    expect(table.b1).toBeUndefined() // 本 tab 租约全部释放

    const hb = h.leaseStub.calls.heartbeat.length
    const writes = h.storage.setItem.mock.calls.filter((c) => c[0] === CONFIG_KEY).length
    h.advance(45000) // interval / trailing timer 全清：不再有 heartbeat、poke、persist
    expect(h.leaseStub.calls.heartbeat.length).toBe(hb)
    expect(r.pokes).toBe(0)
    expect(h.storage.setItem.mock.calls.filter((c) => c[0] === CONFIG_KEY).length).toBe(writes)

    await expect(h.store.startBot('b1')).resolves.toBe(false) // dispose 后拒绝再启动
  })
})

describe('refreshLeases', () => {
  // 审查轮 1 Finding #1：租约判定收口 store——组件不再复刻解析器。
  // 语义：非运行态 bot 以 lease.isHeldElsewhere 重设 rt.otherTab；运行中（本 tab 持有着跑）不动。
  it('他 tab 新鲜租约 → otherTab=true；条目消失 → 复位 false；运行中 bot 不被改写', async () => {
    const h = setup({ table: {} })
    h.store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    h.store.addBot({ id: 'b1', ...CFG })
    h.store.addBot({ id: 'b2', ...CFG, name: '二' })
    expect(h.store.bots[0].rt.otherTab).toBe(false)

    h.table.b1 = 'tab-X' // 他 tab 持有 b1
    h.store.refreshLeases()
    expect(h.store.bots[0].rt.otherTab).toBe(true)
    expect(h.store.bots[1].rt.otherTab).toBe(false)

    // 竞态回归：本 tab startBot 成功后 table.b2 是他 tab 覆盖写——运行态跳过，不误标
    await h.store.startBot('b2')
    expect(h.store.bots[1].rt.status).toBe('connecting')
    h.table.b2 = 'tab-X'
    h.store.refreshLeases()
    expect(h.store.bots[1].rt.otherTab).toBe(false)

    delete h.table.b1 // 租约消失 → 复位
    h.store.refreshLeases()
    expect(h.store.bots[0].rt.otherTab).toBe(false)

    h.store.stopBot('b2') // 停跑后 b2 交还给判定路径：他 tab 仍持有 → true
    h.store.refreshLeases()
    expect(h.store.bots[1].rt.otherTab).toBe(true)
  })

  it('refreshLeases 经注入 storage 的真租约语义（陈旧/本 tab 条目不算持有）', () => {
    let t = 1000000
    const now = () => t
    const storage = makeMemStorage()
    const store = createBotStore({
      wsUrl: 'ws://test',
      storage,
      sessionStorage: makeMemStorage(),
      rng: () => 0.5,
      now,
      deps: { tabId: 'tab-A', createRunner: makeRunnerStub().factory },
    })
    store.addProvider({ id: 'p1', name: 'D', baseUrl: 'https://d', apiKey: 'k' })
    store.addBot({ id: 'b1', ...CFG })
    storage.setItem(LEASE_KEY, JSON.stringify({ b1: { tabId: 'tab-X', ts: now() - 1000 } }))
    store.refreshLeases()
    expect(store.bots[0].rt.otherTab).toBe(true)

    t += STALE_MS // 陈旧 → 不再是持有
    store.refreshLeases()
    expect(store.bots[0].rt.otherTab).toBe(false)

    storage.setItem(LEASE_KEY, JSON.stringify({ b1: { tabId: 'tab-A', ts: now() } })) // 本 tab 条目绝不算
    store.refreshLeases()
    expect(store.bots[0].rt.otherTab).toBe(false)
    store.dispose()
  })
})
