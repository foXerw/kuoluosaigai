// 跨标签页 bot 租约（TabLease）——同一 bot 在两个标签双开会双份 token 互相触发，
// 用 localStorage 里的租约表 `{ [botId]: {tabId, ts} }` 做心跳互斥。纯 ESM 模块，
// 不依赖 Vue、不 import 其他 src/bots 模块；storage/tabId/now/sleep 全可注入便于测试。
//
// acquire 采用「读-改-写 + 写后 sleep(RECHECK_MS) 复查」：两标签同时点启动时双方都会
// 覆盖写入，但复查时只有最后落盘的 holder 是本 tab 的一方返回 true（B20）。
// 心跳节奏由消费方（Task 8 store）驱动，本模块只提供 heartbeat 方法，不设内部定时器。
//
// 降级语义：storage 读/写抛异常（配额/隐私模式）→ degraded 置 true，acquire 仍返回
// true——互斥能力降级但不阻断功能。注意租约值是坏 JSON 不算 IO 故障：视为空表重建，
// 不置 degraded。

export const LEASE_KEY = 'kuoluosaigai:bots:lease'
// HEARTBEAT_MS 单点定义在 core（终审 M4：曾有第二份 15000 巧合相等而静默脱钩），
// 这里只再导出，值不得改。STALE_MS 是租约私有语义，留在本文件。
export { HEARTBEAT_MS } from 'kuoluosaigai-bot-core'
export const STALE_MS = 60000
export const RECHECK_MS = 150

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 创建跨标签租约管理器。
 * @param {{
 *   storage?: { getItem: (k: string) => string | null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void },
 *   tabId?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {{
 *   acquire: (botId: string) => Promise<boolean>,
 *   release: (botId: string) => void,
 *   releaseAll: () => void,
 *   heartbeat: (botId: string) => void,
 *   isHeldElsewhere: (botId: string) => boolean,
 *   get degraded: () => boolean,
 * }}
 */
export function createTabLease({
  storage = globalThis.localStorage,
  // 终审 #1：http 部署（非 secure context）没有 crypto.randomUUID——直接调用会
  // TypeError 炸 App created()。tabId 只需同机唯一（跨 tab 互异即可），不需密码学强度：
  // 时间戳 36 进制 + Math.random 熵足够，且两次构造几乎不可能重号。
  tabId = globalThis.crypto?.randomUUID?.() ?? 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  let degraded = false

  /**
   * 读租约表。返回 null 表示 storage 读取故障（已置 degraded）；
   * 坏 JSON / 空值 / 结构异常视为空表 `{}`（重建交由下一次写）。
   */
  function readTable() {
    let raw
    try {
      raw = storage.getItem(LEASE_KEY)
    } catch {
      degraded = true
      return null
    }
    if (raw == null) return {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      return {}
    } catch {
      return {}
    }
  }

  /** 整表写回。返回是否成功；异常（配额/隐私模式）置 degraded。 */
  function writeTable(table) {
    try {
      storage.setItem(LEASE_KEY, JSON.stringify(table))
      return true
    } catch {
      degraded = true
      return false
    }
  }

  /** 条目新鲜 = ts 是数字且 now() - ts < STALE_MS。 */
  function isFresh(entry) {
    return !!entry && typeof entry.ts === 'number' && now() - entry.ts < STALE_MS
  }

  /**
   * 尝试取得 botId 的本 tab 持有权。
   * - 他 tab 新鲜租约 → 不写、直接 false；
   * - 空闲 / 本 tab / 陈旧（now - ts ≥ STALE_MS）→ 覆盖写入（接管/续期），
   *   sleep(RECHECK_MS) 后复查：holder 仍为本 tab（或条目消失）→ true，被抢 → false；
   * - 存储读写故障 → true（互斥降级不阻断）。
   */
  async function acquire(botId) {
    const table = readTable()
    if (table === null) return true
    const holder = table[botId]
    if (holder && holder.tabId !== tabId && isFresh(holder)) return false

    table[botId] = { tabId, ts: now() }
    if (!writeTable(table)) return true

    await sleep(RECHECK_MS)
    const after = readTable()
    if (after === null) return true
    const rechecked = after[botId]
    return !rechecked || rechecked.tabId === tabId
  }

  /** 刷新本 tab 条目的 ts；条目不存在或已易主则不写。 */
  function heartbeat(botId) {
    const table = readTable()
    if (table === null) return
    const entry = table[botId]
    if (!entry || entry.tabId !== tabId) return
    entry.ts = now()
    writeTable(table)
  }

  /** 释放本 tab 对 botId 的持有；他 tab 的条目不动。 */
  function release(botId) {
    const table = readTable()
    if (table === null) return
    const entry = table[botId]
    if (!entry || entry.tabId !== tabId) return
    delete table[botId]
    writeTable(table)
  }

  /** 清掉本 tab 的全部条目；他 tab 的不动。 */
  function releaseAll() {
    const table = readTable()
    if (table === null) return
    let changed = false
    for (const botId of Object.keys(table)) {
      const entry = table[botId]
      if (entry && entry.tabId === tabId) {
        delete table[botId]
        changed = true
      }
    }
    if (changed) writeTable(table)
  }

  /** 他 tab 是否新鲜持有 botId（陈旧/坏数据/读故障 → false）。 */
  function isHeldElsewhere(botId) {
    const table = readTable()
    if (table === null) return false
    const entry = table[botId]
    return !!entry && entry.tabId !== tabId && isFresh(entry)
  }

  return {
    acquire,
    release,
    releaseAll,
    heartbeat,
    isHeldElsewhere,
    get degraded() {
      return degraded
    },
  }
}
