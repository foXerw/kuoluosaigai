// botStore 浏览器适配层（Task 4 一刀切分：逻辑主体与全部终审/审查轮修复注释已搬入
// packages/bot-core/deck.js 的 createDeck，本文件只做宿主注入，不复刻任何逻辑）。职责——
// 1) 注入 vue 的 reactive（reactiveImpl）、localStorage 默认值、跨标签租约 createTabLease；
//    deps.createLease 在本层消费（tests/botStore.test.js 假租约注入接缝），其余 deps 原样透传。
// 2) sessionStorage 的人类主人昵称读取 → getOwnerNick（浏览器专属存储，core 不该知道）。
// 3) 再导出 core 常量，App/BotDeck/BotCard 的 import 路径零变化。
// createBotStore 签名冻结——tests/botStore.test.js 是指纹级回归证据（R1：断言与用例零改动）。
import { reactive } from 'vue'
import { createDeck } from 'kuoluosaigai-bot-core'
import { createTabLease } from './lease'

export { CONFIG_KEY, SCHEMA_VERSION, MAX_BOTS, PROVIDER_PRESETS } from 'kuoluosaigai-bot-core'

const OWN_NICK_KEY = 'kuoluosaigai:nick' // 人类主人昵称（sessionStorage，沿用 useChat 键）

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
  function getOwnerNick() {
    try {
      const v = ss.getItem(OWN_NICK_KEY)
      return typeof v === 'string' && v ? v : null
    } catch (e) {
      return null
    }
  }

  return createDeck({
    wsUrl,
    storage,
    rng,
    now,
    deps, // 原样透传（含 createRunner/createScheduler/sleep/WebSocketImpl；createLease 仅供下方 lease 组装）
    reactiveImpl: reactive,
    lease: (deps.createLease || createTabLease)({ storage, tabId: deps.tabId, now, sleep: deps.sleep }),
    getOwnerNick,
  })
}
