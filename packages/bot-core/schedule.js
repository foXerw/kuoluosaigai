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
//   不可烧穿额度」（Q9 原文）；daemon 配置校验（Task 4 validateConfig，裁定 R9）
//   应在门外拦住坏钟串，这里是纵深防御——且**不静默吞错**：deck 建 gate 时对该状态
//   发一次性 onEvent('warn', {reason})（审查轮 1 #1），故障可观测。
// - createGate 的 hourAccountor 参数可选（预扫描裁定 R1）：Task 2 留的缺省「不做全局
//   拦截」位，Task 3 由本模块生产 createHourAccountor 并接入（deck 配置了
//   globalHourlyMessages 才注入）。合流顺序已钉：点名可越过静默窗/上线窗，
//   但越不过全局小时闸（§12：预算耗尽连点名也静默——省钱优先于礼貌）。
// - 静默窗内「不主动发起、不接非点名的话」（不调 LLM，省钱生效）；点名照常回——
//   消费方：deck 闲置发起处 + runner 发送决策处（gate 端口）。

// 小时滚动窗口与 rhythm 的 bot 级小时预算同源（裁定 R10 / 终审 M4 教训）：两处
// settleHour 语义必须用同一常量，闸的滚动基准漂移会在整点附近错杀或漏放。
import { HOUR_MS } from './timing.js'

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
 * 造跨 bot 全局小时记账器（P1 Task 3 / §12 成本主闸）：整点自动归零，与
 * rhythm.settleHour 同语义（t - hourStart >= HOUR_MS，R10 起常量同源于 timing.js），
 * 但它是**全 deck 单实例**——rhythm 的 hourlyCap 是每 bot 各计各的，N 个 bot 会把
 * 花费乘 N，本记账器是唯一的全局天花板。
 * 语义钉死：
 * - inc() 逐条入账；canSend() = 「本小时已发条数 < cap」——cap=0 即全时段闭嘴
 *   （显式杀闸合法），负数同理恒 false。cap 的合法性校验归 Task 4 validateConfig
 *   （裁定 R9），此处不做类型警察：调用方应传 Number.isFinite(cap) 且 cap ≥ 0。
 * - inc/count/canSend/settle 都先惰性 settle()：滚动只认注入的 now，不靠真实休眠。
 * - 记账与拦截解耦：谁 inc 由宿主接线面决定（deck 在家族 activity 处 inc），
 *   本模块只管「一小时发了几条、还能不能发」。
 * @param {{ now?: () => number, cap: number }} options
 * @returns {{ inc: () => void, count: () => number, canSend: () => boolean, settle: (t?: number) => void }}
 */
export function createHourAccountor({ now = Date.now, cap } = {}) {
  let hourStart = now()
  let n = 0

  /** 惰性结算滚动小时窗：恰满 HOUR_MS（>= 语义，与 rhythm.settleHour 同一基准）即归零。 */
  function settle(t = now()) {
    if (t - hourStart >= HOUR_MS) {
      hourStart = t
      n = 0
    }
  }

  return {
    /** 记一条「本 deck 真发出去的消息」。无上限守卫：超额入账照常 +1，裁决在 canSend。 */
    inc() {
      settle()
      n += 1
    },
    /** 本小时已入账条数（先滚动，读数恒新鲜；有副作用 = settle，与 rhythm.status 同例）。 */
    count() {
      settle()
      return n
    },
    /** 全局闸裁决：预算未满 true；已满/超负 cap false。先滚动，满闸状态不粘滞到下个整点。 */
    canSend() {
      settle()
      return n < cap
    },
    settle,
  }
}

/**
 * 造发言闸门：静默窗 + 刚上线静默窗 + 全局小时闸（createHourAccountor 实例，
 * 缺省不接 = R1 的浏览器零变化保证）。
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
     *   但越不过 hourAccountor 的全局闸（Task 3 合流顺序，已接实闸）。
     */
    allowSpeak(mentions = false) {
      if (!mentions && quietNow()) return false
      if (hourAccountor && !hourAccountor.canSend()) return false
      return true
    },
  }
}
