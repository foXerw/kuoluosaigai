// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseClock, inQuietWindow, createGate } from 'kuoluosaigai-bot-core'

// schedule 刹车端口（P1 Task 2 / spec Q9 + §12）：纯函数直测，时钟全部注入。
// ts 用「无时区后缀」本地串：Date.parse('2026-11-04T02:00:00') 按执行机本地墙钟
// 解析，inQuietWindow 的 getHours() 读数因此与执行机所在时区无关（跨 CI/UTC 皆稳）。
const at = (hhmm) => Date.parse(`2026-11-04T${hhmm}:00`)

describe('parseClock', () => {
  it('合法 HH:MM → {h, m}', () => {
    expect(parseClock('01:30')).toEqual({ h: 1, m: 30 })
    expect(parseClock('00:00')).toEqual({ h: 0, m: 0 })
    expect(parseClock('23:59')).toEqual({ h: 23, m: 59 })
  })

  it('越界 / 畸形 / 非字符串 → null', () => {
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('1:60')).toBeNull()
    expect(parseClock('abc')).toBeNull()
    expect(parseClock('1:5')).toBeNull() // 分钟必须两位，避免与 '01:05' 二义
    expect(parseClock('01-30')).toBeNull()
    expect(parseClock('')).toBeNull()
    expect(parseClock(undefined)).toBeNull()
    expect(parseClock(null)).toBeNull()
    expect(parseClock(900)).toBeNull()
  })
})

describe('inQuietWindow（本机墙钟；跨零点正确；from===to 全时段）', () => {
  it('窗口 01:30–08:00：02:00 true、09:00 false', () => {
    const W = { from: '01:30', to: '08:00' }
    expect(inQuietWindow(at('02:00'), W)).toBe(true)
    expect(inQuietWindow(at('09:00'), W)).toBe(false)
  })

  it('边界：from 含、to 不含（01:30 true / 07:59 true / 08:00 false / 01:29 false）', () => {
    const W = { from: '01:30', to: '08:00' }
    expect(inQuietWindow(at('01:30'), W)).toBe(true)
    expect(inQuietWindow(at('07:59'), W)).toBe(true)
    expect(inQuietWindow(at('08:00'), W)).toBe(false)
    expect(inQuietWindow(at('01:29'), W)).toBe(false)
  })

  it('跨零点窗口 23:00–06:00：01:00 true、12:00 false（最易写错的反例，显式钉死）', () => {
    const X = { from: '23:00', to: '06:00' }
    expect(inQuietWindow(at('01:00'), X)).toBe(true)
    expect(inQuietWindow(at('12:00'), X)).toBe(false)
    expect(inQuietWindow(at('23:00'), X)).toBe(true)
    expect(inQuietWindow(at('22:59'), X)).toBe(false)
    expect(inQuietWindow(at('05:59'), X)).toBe(true)
    expect(inQuietWindow(at('06:00'), X)).toBe(false)
  })

  it('from === to → 恒 true（全时段静默是规格，不是边界 bug）', () => {
    const A = { from: '08:00', to: '08:00' }
    expect(inQuietWindow(at('08:00'), A)).toBe(true)
    expect(inQuietWindow(at('12:00'), A)).toBe(true)
    expect(inQuietWindow(at('03:00'), A)).toBe(true)
  })

  it('端点缺失/不可解析 → fail-closed 恒 true（宁可不说话，不可误说话）', () => {
    expect(inQuietWindow(at('12:00'), { from: 'abc', to: '08:00' })).toBe(true)
    expect(inQuietWindow(at('12:00'), { from: '01:30' })).toBe(true)
    expect(inQuietWindow(at('12:00'), {})).toBe(true)
  })
})

describe('createGate（静默窗 + 刚上线静默窗；hourAccountor 可选 = 裁定 R1）', () => {
  it('无任何配置 → 恒放行（点名与否都可为）', () => {
    const g = createGate({ now: () => at('12:00') })
    expect(g.quietNow()).toBe(false)
    expect(g.allowSpeak(false)).toBe(true)
    expect(g.allowSpeak(true)).toBe(true)
  })

  it('startupQuietMs：上线 3 分钟内 allowSpeak(false) 为 false，点名 true；到点恰好解除', () => {
    const start = at('12:00')
    let t = start
    const g = createGate({ now: () => t, startupQuietMs: 180000, startedAt: start })
    t = start + 179999
    expect(g.quietNow()).toBe(true)
    expect(g.allowSpeak(false)).toBe(false)
    expect(g.allowSpeak(true)).toBe(true)
    t = start + 180000 // 严格小于：整点即解除
    expect(g.quietNow()).toBe(false)
    expect(g.allowSpeak(false)).toBe(true)
  })

  it('startedAt 缺省 → 取构造时刻；startupQuietMs ≤ 0 / 非法 → 视为未配置', () => {
    let t = at('12:00')
    const g = createGate({ now: () => t, startupQuietMs: 1000 })
    expect(g.allowSpeak(false)).toBe(false)
    t += 1000
    expect(g.allowSpeak(false)).toBe(true)
    const g0 = createGate({ now: () => at('12:00'), startupQuietMs: 0, startedAt: 0 })
    expect(g0.quietNow()).toBe(false)
  })

  it('quietHours 窗内：非点名拦截、点名放行', () => {
    const g = createGate({ now: () => at('02:00'), quietHours: { from: '01:30', to: '08:00' } })
    expect(g.quietNow()).toBe(true)
    expect(g.allowSpeak(false)).toBe(false)
    expect(g.allowSpeak(true)).toBe(true)
  })

  it('hourAccountor（缺省不接 = R1）：点名可越过静默窗，但越不过全局闸', () => {
    const inWindow = createGate({
      now: () => at('02:00'),
      quietHours: { from: '01:30', to: '08:00' },
      hourAccountor: { canSend: () => false },
    })
    expect(inWindow.allowSpeak(false)).toBe(false)
    expect(inWindow.allowSpeak(true)).toBe(false) // 全局闸满：点名也不发（Task 3 的合流顺序）
    expect(inWindow.quietNow()).toBe(true) // quietNow 仍是窗语义——预算不算「静默」

    const open = createGate({ now: () => at('12:00'), hourAccountor: { canSend: () => true } })
    expect(open.allowSpeak(false)).toBe(true)
    expect(open.allowSpeak(true)).toBe(true)

    const none = createGate({ now: () => at('02:00'), quietHours: { from: '01:30', to: '08:00' } })
    expect(none.allowSpeak(true)).toBe(true) // 缺省即「不做全局拦截」
  })

  it('quietHours 与 startupQuietMs 同时配置：任一命中即 quietNow；双双解除才放行', () => {
    const start = at('23:00') // 上线即 23:00：静默窗（跨零点 23:00–06:00）也覆盖
    let t = start
    const g = createGate({
      now: () => t,
      quietHours: { from: '23:00', to: '06:00' },
      startupQuietMs: 1800000,
      startedAt: start,
    })
    expect(g.quietNow()).toBe(true)
    expect(g.allowSpeak(false)).toBe(false)
    t = Date.parse('2026-11-05T12:00:00') // 次日 12:00：上线窗（30min）早已结束，且不在 23:00–06:00 内
    expect(g.quietNow()).toBe(false)
    expect(g.allowSpeak(false)).toBe(true)
  })
})
