// botStore（Task 8 / spec §10）：App 层 reactive 单例。职责——
// 1) 配置持久化：键 kuoluosaigai:bots:v1，载荷 {version, providers, bots(剥 rt), lifetime}；
//    坏 JSON/version≠1 → 丢弃重建为空不抛（B15）；写失败 → storageDegraded 仅内存（B17）。
// 2) runner 注册表：runner 实例存非响应式 Map（reactive 只放配置 + rt 视图）；
//    startBot 每次新建 runner（旧实例先停），stop 后保留实例供 getBuffer 观战读取。
// 3) 跨标签租约互斥（B20）：startBot 先 acquire，败者 rt.otherTab=true；
//    acquire 是 await——resolve 后复查启动意图与 bot 存续（窗口期 remove/stop/dispose
//    插队则归还已取得租约并放弃，审查轮 1 #3 防幽灵 runner）；
//    运行期由全局 15s interval 驱动 lease.heartbeat；stop/fatal-stop 释放租约。
// 4) 家族闲置调度：每房一个 createIdleScheduler，全局 interval（终审 M4：以 lease
//    导出的 HEARTBEAT_MS=15s 为权威周期，idle 检查搭同一班车）遍历运行中 bot 按房分组 tick；candidates 是真门禁+真骰子的代理——
//    canInitiateIdle → runner.idleEligible()（transport && rhythm B21 门禁），
//    rollIdle → runner.idleRoll()（rhythm 权威掷骰，含 chattiness 系数，恰 1 次 rng）；
//    调度器据此洗牌轮掷、首个通过者中签，winner 以 pokeIdle({preRolled:true}) 直发
//    （不再二次掷，防概率平方化）；全员未过 → 调度器按 afterChat 短窗重开（审查轮 1 #1）。
//    房内无运行 bot → 该房调度器回收。runner onEvent('activity') → 对应房
//    notifyActivity(payload.family===true 透传，终审 #7：家族消息不腰斩 idle 长窗)。
// 5) 用量累计：onState.session 绝对值与基线差分增量写 lifetime；持久化节流至多每 10s
//    一次（trailing 合并，内存即时更新）。
// B18：只 import vue/reactive 与 src/bots/{rhythm,lease,runner}；不碰 useChat/roomCache/roomList。
import { reactive } from 'vue'
import { createIdleScheduler } from './rhythm'
import { createTabLease, HEARTBEAT_MS } from './lease'
import { createBotRunner } from './runner'

export const CONFIG_KEY = 'kuoluosaigai:bots:v1'
export const SCHEMA_VERSION = 1
export const MAX_BOTS = 5
export const PROVIDER_PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
]

const OWN_NICK_KEY = 'kuoluosaigai:nick' // 人类主人昵称（sessionStorage，沿用 useChat 键）
const LIFETIME_PERSIST_MS = 10000 // lifetime 增量持久化节流窗口
const BOT_CFG_KEYS = ['id', 'name', 'persona', 'chattiness', 'providerId', 'model', 'temperature', 'rawPrompt', 'roomId', 'nick']
const PROVIDER_KEYS = ['id', 'name', 'baseUrl', 'apiKey']
const RT_MERGE_KEYS = ['status', 'error', 'nick', 'roomId', 'hourCount', 'rev']

function pick(obj, keys) {
  const out = {}
  for (const k of keys) out[k] = obj && obj[k] !== undefined ? obj[k] : null
  return out
}

/**
 * 创建 bot 单例 store（Task 9/10 唯一入口）。
 * @param {{
 *   wsUrl?: string,
 *   storage?: Storage,
 *   sessionStorage?: Storage,
 *   rng?: () => number,
 *   now?: () => number,
 *   deps?: {
 *     createRunner?: Function, createLease?: Function, createScheduler?: Function,
 *     tabId?: string, sleep?: Function, WebSocketImpl?: Function,
 *   },
 * }} [options]
 * @returns {object} reactive store（providers/bots/lifetime/storageDegraded/leaseDegraded + 方法）
 */
export function createBotStore({
  wsUrl = '',
  storage = globalThis.localStorage,
  sessionStorage: ss = globalThis.sessionStorage,
  rng = Math.random,
  now = Date.now,
  deps = {},
} = {}) {
  const createRunner = deps.createRunner || createBotRunner
  const createLease = deps.createLease || createTabLease
  const createScheduler = deps.createScheduler || createIdleScheduler

  const lease = createLease({ storage, tabId: deps.tabId, now, sleep: deps.sleep })

  const runners = new Map() // 非响应式：botId → runner 实例
  const schedulers = new Map() // roomId → idle scheduler
  const sessionBaselines = new Map() // botId → 本 runner 上次上报的绝对 session 用量
  const running = new Set() // store 视角「运行中」的 botId（含 connecting/cooling）
  const intent = new Map() // botId → 最新 startBot 尝试的 token（审查轮 1 #3：await 窗口竞态作废）
  let startSeq = 0
  let tickTimer = null
  let lifetimeTimer = null
  let lastPersistAt = -Infinity
  let disposed = false
  let botSeq = 0
  let provSeq = 0

  const store = reactive({
    providers: [],
    bots: [], // 每项 = reactive({ ...cfg, rt: {...}, bufferFrames() })
    lifetime: {}, // botId → {promptTokens, completionTokens}（跨重启累计）
    storageDegraded: false,
    get leaseDegraded() {
      return !!lease.degraded
    },

    // —— providers ——
    addProvider(cfg = {}) {
      const p = normalizeProvider(cfg, `provider-${provSeq++}`)
      store.providers.push(p)
      persist()
      return { ok: true, provider: p }
    },
    updateProvider(id, patch = {}) {
      const p = store.providers.find((x) => x.id === id)
      if (!p) return false
      for (const k of ['name', 'baseUrl', 'apiKey']) {
        if (k in patch) p[k] = String(patch[k] ?? '')
      }
      persist()
      return true
    },
    removeProvider(id) {
      const i = store.providers.findIndex((x) => x.id === id)
      if (i === -1) return false
      store.providers.splice(i, 1)
      persist()
      return true
    },

    // —— bots 配置 ——
    addBot(cfg = {}) {
      if (store.bots.length >= MAX_BOTS) return { error: 'MAX_BOTS' }
      const item = makeBotItem(normalizeCfg(cfg, `bot-${botSeq++}`))
      store.bots.push(item)
      persist()
      return { ok: true }
    },
    updateBot(id, patch = {}) {
      const item = findBot(id)
      if (!item) return false
      for (const k of BOT_CFG_KEYS) {
        if (k === 'id' || !(k in patch)) continue
        let v = patch[k]
        if (k === 'name') v = String(v ?? '').slice(0, 12) // 全局约束：人格名 ≤12
        if (k === 'nick') v = typeof v === 'string' && v ? v : null
        item[k] = v
      }
      if ('roomId' in patch && !running.has(id)) item.rt.roomId = item.roomId || null
      persist()
      return true
    },
    removeBot(id) {
      const idx = store.bots.findIndex((b) => b.id === id)
      if (idx === -1) return false
      if (running.has(id)) {
        stopBotInternal(id) // 运行中先 stop（含释放租约/调度回收）
      } else {
        const r = runners.get(id) // 遗留的已停实例：幂等停一下再丢
        if (r) {
          try { r.stop() } catch (e) { /* noop */ }
        }
      }
      runners.delete(id)
      running.delete(id)
      intent.delete(id)
      lease.release(id)
      sessionBaselines.delete(id)
      delete store.lifetime[id]
      store.bots.splice(idx, 1)
      pruneSchedulers()
      maybeStopTick()
      persist()
      return true
    },

    // —— 生命周期 ——
    async startBot(id) {
      if (disposed) return false
      const item = findBot(id)
      if (!item) return false
      if (running.has(id)) return true
      const token = ++startSeq
      intent.set(id, token)
      const rt = item.rt
      rt.otherTab = false
      rt.error = null // null-as-absent 只作用于 runner patch 合并；store 主动复位
      rt.status = 'connecting' // 终审 #3 双保险：acquire 窗口期即禁用启动钮，失败路径回滚
      const ok = await lease.acquire(id)
      // acquire 的 await 窗口内 removeBot/stopBot/dispose 插队 → 意图作废；
      // 已取得的租约必须归还，否则本 bot 被幽灵持有着 60s 谁都起不来（审查轮 1 #3）。
      // 终审 #3：区分「被顶掉」与「被撤销」——intent 槽仍挂着更新 token 说明胜出尝试
      // 本就在为这条租约条目奔波，旧尝试 release 会误删胜出者刚写好的条目，且 heartbeat
      // 不重建消失条目 → 跨 tab 互斥静默失效；被顶掉一律静默退场。
      if (disposed || intent.get(id) !== token || !findBot(id)) {
        if (intent.get(id) === undefined) {
          // 撤销（stop/remove/dispose 清空意图）：无人认领已取得的租约，归还 + 回滚占位状态
          if (ok) lease.release(id)
          if (rt.status === 'connecting') rt.status = 'stopped'
        }
        return false
      }
      if (!ok) {
        rt.otherTab = true
        rt.status = 'stopped' // 终审 #3：失败回滚，别永挂 CONNECTING
        return false
      }
      const stale = runners.get(id) // 上次运行的实例（缓冲/终态遗留）：让位新 runner
      if (stale) {
        try { stale.stop() } catch (e) { /* noop */ }
      }
      sessionBaselines.set(id, { promptTokens: 0, completionTokens: 0 })
      let runner
      try {
        runner = createRunner(makeRunnerOpts(item))
      } catch (e) {
        lease.release(id)
        rt.status = 'error'
        rt.error = '启动失败'
        return false
      }
      runners.set(id, runner)
      running.add(id)
      // rt.status 已在 acquire 前置为 connecting（终审 #3 双保险），胜者直接续用
      const room = rt.roomId || item.roomId
      if (room) ensureScheduler(room)
      ensureTick()
      try {
        runner.start() // runner 自带 provider 配置校验：缺失→onState error，不连接
      } catch (e) {
        /* 分级处置在 runner 内部；此处兜底不让 store 炸 */
      }
      return true
    },

    stopBot(id) {
      stopBotInternal(id)
    },

    switchBotRoom(id, roomId) {
      const item = findBot(id)
      if (!item || typeof roomId !== 'string' || !roomId) return false
      item.roomId = roomId
      if (running.has(id)) {
        const r = runners.get(id)
        if (r) {
          try { r.switchRoom(roomId) } catch (e) { /* noop */ }
        }
      }
      item.rt.roomId = roomId
      pruneSchedulers()
      persist()
      return true
    },

    clearBotBuffer(id) {
      const r = runners.get(id)
      if (r) r.clearBuffer()
    },

    /**
     * 租约状态重查（审查轮 1 Finding #1）：消费方（Task 9 面板）收到 window 'storage'
     * 事件（LEASE_KEY）后调本方法——租约结构/新鲜度/tabId 排除只此一份权威判定
     * （lease.isHeldElsewhere），组件不得复刻解析器。
     * 语义：非运行态 bot 以 isHeldElsewhere 重设 rt.otherTab；本 tab 运行中的 bot
     * 跳过——其 otherTab 归 start/stop 生命周期语义管（防 acquire 窗口期竞态误标）。
     */
    refreshLeases() {
      for (const item of store.bots) {
        if (running.has(item.id)) continue
        item.rt.otherTab = lease.isHeldElsewhere(item.id)
      }
    },

    // getBuffer 是权威缓冲入口（裁定 F3）；bot.bufferFrames() 只是委托糖
    getBuffer(id) {
      const r = runners.get(id)
      return r ? r.getBuffer() : []
    },

    load() {
      loadInto()
    },
    persist() {
      persist()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }
      if (lifetimeTimer) {
        clearTimeout(lifetimeTimer)
        lifetimeTimer = null
      }
      for (const id of [...running]) {
        const r = runners.get(id)
        if (r) {
          try { r.stop() } catch (e) { /* noop */ }
        }
      }
      running.clear()
      intent.clear()
      lease.releaseAll()
      schedulers.clear()
      persist() // 最终落盘 lifetime（B12：dispose 前冲刷）
    },
  })

  // —— 内部实现（闭包区，函数声明提升供上面方法体引用）——

  function findBot(id) {
    return store.bots.find((b) => b.id === id) || null
  }

  function makeBotItem(cfg) {
    return {
      ...cfg,
      rt: {
        status: 'stopped',
        error: null,
        nick: cfg.nick || null,
        roomId: cfg.roomId || null,
        session: { promptTokens: 0, completionTokens: 0, messages: 0 },
        hourCount: 0,
        otherTab: false,
        rev: 0,
      },
      bufferFrames: () => store.getBuffer(cfg.id), // 委托糖（裁定 F3：getBuffer 是权威入口）
    }
  }

  function stopBotInternal(id) {
    intent.delete(id) // 作废在途 startBot 尝试（审查轮 1 #3）
    const was = running.delete(id)
    const r = runners.get(id)
    if (r) {
      try { r.stop() } catch (e) { /* noop */ }
    }
    if (was) {
      lease.release(id)
    }
    const item = findBot(id)
    if (item) {
      item.rt.status = 'stopped'
      item.rt.error = null
      item.rt.otherTab = false
    }
    pruneSchedulers()
    maybeStopTick()
  }

  function normalizeCfg(c, fallbackId) {
    const chattiness = Number(c.chattiness)
    const temperature = Number(c.temperature)
    return {
      id: typeof c.id === 'string' && c.id ? c.id : String(fallbackId || ''),
      name: String(c.name ?? '').slice(0, 12),
      persona: String(c.persona ?? ''),
      chattiness: Number.isFinite(chattiness) ? chattiness : 50,
      providerId: c.providerId ?? null,
      model: String(c.model ?? ''),
      temperature: Number.isFinite(temperature) ? temperature : 0.9, // spec §7 钉死默认（终审 M1，曾误 0.7）
      rawPrompt: String(c.rawPrompt ?? ''),
      roomId: typeof c.roomId === 'string' ? c.roomId : '',
      nick: typeof c.nick === 'string' && c.nick ? c.nick : null,
    }
  }

  function normalizeProvider(p, fallbackId) {
    return {
      id: typeof p.id === 'string' && p.id ? p.id : String(fallbackId || ''),
      name: String(p.name ?? ''),
      baseUrl: String(p.baseUrl ?? ''),
      apiKey: String(p.apiKey ?? ''),
    }
  }

  function resetState() {
    store.providers.splice(0)
    store.bots.splice(0)
    for (const k of Object.keys(store.lifetime)) delete store.lifetime[k]
  }

  function loadInto() {
    let raw
    try {
      raw = storage.getItem(CONFIG_KEY)
    } catch (e) {
      store.storageDegraded = true
      resetState()
      return
    }
    if (raw == null) {
      resetState()
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      resetState() // B15：坏 JSON → 丢弃重建，不抛
      return
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== SCHEMA_VERSION ||
      !Array.isArray(parsed.providers) ||
      !Array.isArray(parsed.bots)
    ) {
      resetState() // B15：version≠1 / 结构异常 → 同上
      return
    }
    resetState()
    // 终审 #2：载荷内重复 id 去重保首个（历史污染数据防御——重复 id 会让
    // findBot 恒中第一个、runners/lease 同键互踩、UI 删不净）
    const seenProvider = new Set()
    for (const p of parsed.providers) {
      if (p && typeof p === 'object' && typeof p.id === 'string' && !seenProvider.has(p.id)) {
        seenProvider.add(p.id)
        store.providers.push(normalizeProvider(p, p.id))
      }
    }
    const seenBot = new Set()
    for (const c of parsed.bots) {
      if (!c || typeof c !== 'object') continue
      const cfg = normalizeCfg(c, '')
      if (cfg.id && !seenBot.has(cfg.id)) {
        seenBot.add(cfg.id)
        store.bots.push(makeBotItem(cfg))
      }
    }
    // 终审 #2：id 计数器对账——扫已载入的自造 id 回填 botSeq/provSeq 到 max+1，
    // 否则「刷新后新建」从 0 重放必撞号（本会话后续 persist 会永久污染载荷）
    for (const b of store.bots) {
      const m = /^bot-(\d+)$/.exec(b.id)
      if (m) botSeq = Math.max(botSeq, Number(m[1]) + 1)
    }
    for (const p of store.providers) {
      const m = /^provider-(\d+)$/.exec(p.id)
      if (m) provSeq = Math.max(provSeq, Number(m[1]) + 1)
    }
    const lt = parsed.lifetime
    if (lt && typeof lt === 'object' && !Array.isArray(lt)) {
      for (const [k, v] of Object.entries(lt)) {
        if (v && typeof v === 'object') {
          store.lifetime[k] = { promptTokens: Number(v.promptTokens) || 0, completionTokens: Number(v.completionTokens) || 0 }
        }
      }
    }
  }

  function persist() {
    const payload = {
      version: SCHEMA_VERSION,
      providers: store.providers.map((p) => pick(p, PROVIDER_KEYS)),
      bots: store.bots.map((b) => pick(b, BOT_CFG_KEYS)), // 剥 rt 与方法
      lifetime: {},
    }
    for (const [k, v] of Object.entries(store.lifetime)) {
      payload.lifetime[k] = { promptTokens: v.promptTokens || 0, completionTokens: v.completionTokens || 0 }
    }
    try {
      storage.setItem(CONFIG_KEY, JSON.stringify(payload))
      lastPersistAt = now()
    } catch (e) {
      store.storageDegraded = true // B17：写失败 → 仅内存，不抛
    }
  }

  function getOwnerNick() {
    try {
      const v = ss.getItem(OWN_NICK_KEY)
      return typeof v === 'string' && v ? v : null
    } catch (e) {
      return null
    }
  }

  function familyNicks() {
    const set = new Set()
    for (const id of running) {
      const item = findBot(id)
      if (item && item.rt.nick) set.add(item.rt.nick)
    }
    return [...set]
  }

  function makeRunnerOpts(item) {
    const provider = store.providers.find((p) => p.id === item.providerId) || {}
    return {
      bot: pick(item, BOT_CFG_KEYS), // 纯配置快照（rt 不进 runner）
      provider: pick(provider, PROVIDER_KEYS),
      wsUrl,
      getOwnerNick,
      getFamilyNicks: familyNicks,
      rng,
      now,
      WebSocketImpl: deps.WebSocketImpl,
      sleep: deps.sleep,
      onState: (patch) => mergeState(item.id, patch),
      onEvent: (type, payload) => handleEvent(item.id, type, payload),
    }
  }

  /** onState patch 合并进 rt；null-as-absent（runner 非致命 stop 显式带 error:null，不误清） */
  function mergeState(id, patch) {
    const item = findBot(id)
    if (!item || !patch || typeof patch !== 'object') return
    const rt = item.rt
    for (const key of RT_MERGE_KEYS) {
      if (key in patch && patch[key] !== null && patch[key] !== undefined) rt[key] = patch[key]
    }
    if (patch.session && typeof patch.session === 'object') {
      rt.session = {
        promptTokens: Number(patch.session.promptTokens) || 0,
        completionTokens: Number(patch.session.completionTokens) || 0,
        messages: Number(patch.session.messages) || 0,
      }
      applySessionDelta(id, rt.session)
    }
  }

  function applySessionDelta(id, s) {
    const base = sessionBaselines.get(id) || { promptTokens: 0, completionTokens: 0 }
    const dP = s.promptTokens - base.promptTokens
    const dC = s.completionTokens - base.completionTokens
    sessionBaselines.set(id, { promptTokens: s.promptTokens, completionTokens: s.completionTokens })
    if (dP <= 0 && dC <= 0) return
    if (!store.lifetime[id]) store.lifetime[id] = { promptTokens: 0, completionTokens: 0 }
    const lt = store.lifetime[id]
    lt.promptTokens += Math.max(0, dP)
    lt.completionTokens += Math.max(0, dC)
    scheduleLifetimePersist()
  }

  /** 节流：距上次落盘 ≥10s 立即写；窗口内合并到一个 trailing 定时（至多每 10s 一次）。 */
  function scheduleLifetimePersist() {
    if (disposed || lifetimeTimer) return
    const elapsed = now() - lastPersistAt
    if (elapsed >= LIFETIME_PERSIST_MS) {
      persist()
      return
    }
    lifetimeTimer = setTimeout(() => {
      lifetimeTimer = null
      if (!disposed) persist()
    }, Math.max(0, LIFETIME_PERSIST_MS - elapsed))
  }

  function handleEvent(id, type, payload) {
    if (type === 'activity') {
      // 终审 #7：转发 runner 的 family 标志——家族活动走调度器 max 语义保 idle 长窗，
      // 真人活动完全重置
      const room = payload && payload.roomId
      if (room && running.has(id)) ensureScheduler(room).notifyActivity(payload.family === true)
    } else if (type === 'nick') {
      const item = findBot(id)
      if (item && payload && payload.nick) {
        item.nick = payload.nick // 身份跨刷新延续：写回配置并持久化
        persist()
      }
    } else if (type === 'stopped') {
      // runner 致命 stop（SLOW DOWN / TOKEN 失效 / 配置缺失 / 重试耗尽）：本 tab 不再驱动
      if (!running.delete(id)) return
      lease.release(id)
      pruneSchedulers()
      maybeStopTick()
    }
  }

  function ensureScheduler(room) {
    let s = schedulers.get(room)
    if (!s) {
      s = createScheduler({ rng, now })
      schedulers.set(room, s)
    }
    return s
  }

  function currentRooms() {
    const rooms = new Set()
    for (const id of running) {
      const item = findBot(id)
      if (!item) continue
      const room = item.rt.roomId || item.roomId
      if (room) rooms.add(room)
    }
    return rooms
  }

  /** bot 全部停止的房间 → 调度器回收 */
  function pruneSchedulers() {
    const live = currentRooms()
    for (const room of [...schedulers.keys()]) {
      if (!live.has(room)) schedulers.delete(room)
    }
  }

  function onGlobalTick() {
    if (disposed) return
    for (const id of running) lease.heartbeat(id) // 心跳节奏由 store 驱动（T6 契约）
    const rooms = currentRooms()
    for (const room of [...schedulers.keys()]) {
      if (!rooms.has(room)) schedulers.delete(room)
    }
    for (const room of rooms) {
      const sched = ensureScheduler(room)
      const candidates = []
      for (const id of running) {
        const item = findBot(id)
        if (!item) continue
        const r = item.rt.roomId || item.roomId
        if (r !== room) continue
        const botId = item.id
        candidates.push({
          id: botId,
          // 真门禁+真骰子代理（审查轮 1 #1）：idleEligible 含 transport 与 rhythm B21
          // 全部门禁；idleRoll 消耗恰 1 次 rng（rhythm 权威掷骰，含 chattiness 系数）。
          // 调度器据此「依次轮掷直到首个通过」，全员未过走 afterChat 短窗重开。
          canInitiateIdle: () => {
            const runner = runners.get(botId)
            return runner ? runner.idleEligible() === true : false
          },
          rollIdle: () => {
            const runner = runners.get(botId)
            return runner ? runner.idleRoll() === true : false
          },
        })
      }
      const winner = sched.tick(candidates)
      if (winner) {
        const runner = runners.get(winner)
        // candidates 已问过 eligible+roll → preRolled 直发，避免 runner 二次掷平方化概率
        if (runner) runner.pokeIdle({ preRolled: true })
      }
    }
    maybeStopTick()
  }

  function ensureTick() {
    if (disposed || tickTimer) return
    // 终审 M4：全局 tick 以租约心跳周期为权威常量（lease 导出 HEARTBEAT_MS），
    // 不再借用 RHYTHM_DEFAULTS.idleCheckMs——两个 15000 曾是巧合同值
    tickTimer = setInterval(onGlobalTick, HEARTBEAT_MS)
  }

  function maybeStopTick() {
    if (tickTimer && running.size === 0 && schedulers.size === 0) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  loadInto()

  return store
}
