// schedule（P1 Task 2 / spec Q9 + §12）：daemon 常驻模式的成本刹车端口——
// 静默窗（quietHours）+ 刚上线静默窗（startupQuietMs）。浏览器里「关掉标签页」
// 是免费的总闸；daemon 24/7 无人盯屏时没有等价操作，凌晨空房会让 bot 自说自话
// 烧真金白银。本模块把「什么时候允许开口」做成纯逻辑：时钟全注入、无 IO、零依赖。
//
// 设计钉死：
// - 本机墙钟语义：inQuietWindow 用 new Date(ts) 的 getHours()/getMinutes() 读数
//   （Date 是 JS 全局，B18 core 纯度合法；不是 node: 内建、不是浏览器全局）。
// - 窗口 [from, to)：from 含、to 不含。from ≤ to 为当日窗；from > to 跨零点，
//   判定 = (cur >= from || cur < to)；from === to 视为全时段静默（规格明求，
//   不是边界巧合）。以「当日分钟数」比较而非整点小时，01:30 的窗不会吞掉 01:00。
// - 端点缺失/不可解析 → fail-closed 判静默：刹车的天职是省钱，「宁显得没睡醒，
//   不可烧穿额度」（Q9 原文）；daemon 配置校验（Task 4 validateConfig）应在门外
//   拦住坏钟串，这里是纵深防御。
// - createGate 的 hourAccountor 参数可选（预扫描裁定 R1）：本任务不生产它，
//   缺省即「不做全局拦截」；Task 3 造 createHourAccountor 并接入。合流顺序已钉：
//   点名可越过静默窗/上线窗，但越不过全局小时闸。
// - 静默窗内「不主动发起、不接非点名的话」（不调 LLM，省钱生效）；点名照常回——
//   消费方：deck 闲置发起处 + runner 发送决策处（gate 端口）。

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/

/**
 * 解析 'HH:MM' 墙钟串（小时 1~2 位、分钟恰 2 位）。
 * @param {unknown} s
 * @returns {{h: number, m: number} | null} 越界（h>23 / m>59）或畸形 → null
 */
export function parseClock(s) {
  if (typeof s !== 'string') return null
  const m = CLOCK_RE.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

/** epoch ms → 本机墙钟的当日分钟数 [0, 1440)。 */
function wallMinutes(ts) {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * ts 时刻是否落在 {from, to} 静默窗内（按本机墙钟）。
 * 跨零点窗（from > to）：(cur>=from || cur<to)；当日窗：(cur>=from && cur<to)。
 * from === to 或端点不可解析 → 恒 true（全时段静默，fail-closed）。
 * @param {number} ts epoch 毫秒
 * @param {{from?: unknown, to?: unknown}} [window] 两端 'HH:MM' 串
 * @returns {boolean}
 */
export function inQuietWindow(ts, { from, to } = {}) {
  const f = parseClock(from)
  const t = parseClock(to)
  if (!f || !t) return true
  const fromMin = f.h * 60 + f.m
  const toMin = t.h * 60 + t.m
  if (fromMin === toMin) return true
  const cur = wallMinutes(ts)
  return fromMin <= toMin ? cur >= fromMin && cur < toMin : cur >= fromMin || cur < toMin
}

/**
 * 造发言闸门：静默窗 + 刚上线静默窗（+ Task 3 的全局小时闸插槽，本任务缺省不接）。
 * @param {{
 *   now?: () => number,
 *   quietHours?: { from?: string, to?: string } | null,
 *   startupQuietMs?: number | null,
 *   startedAt?: number, // 缺省 → 取构造时刻（daemon 冷启动即建 gate，语义天然对齐）
 *   hourAccountor?: { canSend: () => boolean } | null, // R1：可选，缺省不做全局拦截
 * }} [options] startupQuietMs ≤ 0 或非有限数 → 视为未配置
 * @returns {{ quietNow: () => boolean, allowSpeak: (mentions?: boolean) => boolean }}
 */
export function createGate({
  now = Date.now,
  quietHours = null,
  startupQuietMs = null,
  startedAt,
  hourAccountor = null,
} = {}) {
  const start = Number.isFinite(startedAt) ? startedAt : now()
  const quietMs = Number.isFinite(startupQuietMs) && startupQuietMs > 0 ? startupQuietMs : null

  function inStartupQuiet() {
    return quietMs !== null && now() - start < quietMs
  }

  /** 当前是否处于任一静默窗（预算闸不算「静默」——那是 canSend 维度的事）。 */
  function quietNow() {
    if (quietHours && inQuietWindow(now(), quietHours)) return true
    return inStartupQuiet()
  }

  return {
    quietNow,
    /**
     * 此刻是否允许开口发起/接话。
     * @param {boolean} [mentions] 点名：越过静默窗（Q9「被 @ 仍可回」），
     *   但越不过 hourAccountor 的全局闸（Task 3 合流顺序，此处留位）。
     */
    allowSpeak(mentions = false) {
      if (!mentions && quietNow()) return false
      if (hourAccountor && !hourAccountor.canSend()) return false
      return true
    },
  }
}
