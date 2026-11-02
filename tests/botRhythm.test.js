import { describe, it, expect } from 'vitest'
import {
  RHYTHM_DEFAULTS,
  trailingFamilyStreak,
  createRhythm,
  createIdleScheduler,
} from 'kuoluosaigai-bot-core'

// RhythmEngine 测试（Task 2，spec §7 / 裁定 F1+F2）。
// 确定性策略：注入「逐值弹出」的序列 rng——构造时消耗 1 个值（streakLimit 首掷），
// 之后每次 rng() 严格按 decide 判定顺序（冷却→AFK→预算→间隔→streak→概率）消耗；
// 值用尽后再被调用会抛错，从而钉死「不该掷骰的分支绝不消耗 rng」。
// 区间助手 between(rng,[lo,hi]) = lo + floor(rng()*(hi-lo+1))，据此手工推算期望值。

function seqRng(values) {
  let i = 0
  const rng = () => {
    if (i >= values.length) {
      throw new Error(`rng 超量消耗：第 ${i + 1} 次调用，但只准备了 ${values.length} 个值`)
    }
    return values[i++]
  }
  rng.count = () => i
  return rng
}

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    set: (v) => { t = v },
    advance: (d) => { t += d },
  }
}

// 调度器候选桩：记录 canInitiateIdle / rollIdle 调用次数（验证 && 短路）
function cand(id, can, roll) {
  const c = {
    id,
    canCount: 0,
    rollCount: 0,
    canInitiateIdle() { c.canCount++; return can },
    rollIdle() { c.rollCount++; return roll },
  }
  return c
}

describe('RHYTHM_DEFAULTS', () => {
  it('与 spec §7 钉死常量逐项一致', () => {
    expect(RHYTHM_DEFAULTS).toEqual({
      replyBase: { mention: 0.9, owner: 0.7, human: 0.4, bot: 0.2 },
      thinkMs: [2000, 8000],
      typingMsPer50: [1000, 2000],
      totalDelayCapMs: 15000,
      streakLimit: [6, 10],
      cooldownMs: [30000, 120000],
      hourlyCap: 30,
      minGapMs: 8000,
      afkRollProb: 0.15,
      afkMs: [300000, 1200000],
      idleBaseProb: 0.3,
      idleWindowAfterChatMs: [180000, 480000],
      idleWindowAfterIdleMs: [480000, 900000],
      idleCheckMs: 15000,
    })
  })
})

describe('trailingFamilyStreak', () => {
  const f = (nick) => ({ nick })

  it('从尾部数 nick ∈ 集合的连续条数', () => {
    expect(trailingFamilyStreak([f('a'), f('x'), f('a'), f('a')], new Set(['a']))).toBe(2)
    expect(trailingFamilyStreak([f('a'), f('a'), f('a')], new Set(['a']))).toBe(3)
    expect(trailingFamilyStreak([f('x'), f('a')], new Set(['a']))).toBe(1)
    expect(trailingFamilyStreak([f('x'), f('y')], new Set(['a']))).toBe(0)
  })

  it('空数组 / undefined → 0', () => {
    expect(trailingFamilyStreak([], new Set(['a']))).toBe(0)
    expect(trailingFamilyStreak(undefined, new Set(['a']))).toBe(0)
  })
})

describe('createRhythm：概率分档（裁定 F1：decide 收 familyStreak）', () => {
  // between([6,10], v=0) = 6；between([2000,8000], v=0.5) = 5000；v=0 → 2000
  it('点名概率 = 0.9 × factor(chattiness=50 → 1.0)：rng<0.9 通过、≥0.9 拒绝', () => {
    const clock = fakeClock()
    const hit = createRhythm({ rng: seqRng([0, 0.89, 0.5]), now: clock.now })
    expect(hit.decide({ mentions: true })).toEqual({ thinkMs: 5000 })

    const miss = createRhythm({ rng: seqRng([0, 0.9]), now: clock.now })
    expect(miss.decide({ mentions: true })).toBe(null)
  })

  it('isFamily → 0.2 档；isOwner → 0.7 档；默认真人 → 0.4 档', () => {
    const clock = fakeClock()
    const acc = (rng, input) => createRhythm({ rng, now: clock.now }).decide(input)

    expect(acc(seqRng([0, 0.1, 0.5]), { isFamily: true })).toEqual({ thinkMs: 5000 })
    expect(acc(seqRng([0, 0.2]), { isFamily: true })).toBe(null)

    expect(acc(seqRng([0, 0.69, 0.5]), { isOwner: true })).toEqual({ thinkMs: 5000 })
    expect(acc(seqRng([0, 0.7]), { isOwner: true })).toBe(null)

    expect(acc(seqRng([0, 0.39, 0.5]), {})).toEqual({ thinkMs: 5000 })
    expect(acc(seqRng([0, 0.4]), {})).toBe(null)
  })

  it('mentions 优先于 owner/family 档位（点名帧用 0.9 档）', () => {
    const clock = fakeClock()
    // 若误用 bot 档 0.2，rng=0.85 会被拒；通过证明走的是 mention 档
    const r = createRhythm({ rng: seqRng([0, 0.85, 0.5]), now: clock.now })
    expect(r.decide({ mentions: true, isOwner: true, isFamily: true })).toEqual({ thinkMs: 5000 })
  })

  it('话痨度系数 factor = 0.2 + 1.6×(chattiness/100)，概率 clamp [0,1]', () => {
    const clock = fakeClock()
    // chattiness=0 → 0.2x：mention 档 0.9*0.2=0.18
    const quiet = createRhythm({ rng: seqRng([0, 0.1, 0.5]), now: clock.now, chattiness: 0 })
    expect(quiet.decide({ mentions: true })).toEqual({ thinkMs: 5000 })
    const quiet2 = createRhythm({ rng: seqRng([0, 0.19]), now: clock.now, chattiness: 0 })
    expect(quiet2.decide({ mentions: true })).toBe(null)

    // chattiness=100 → 1.8x：owner 档 0.7*1.8=1.26 → clamp 到 1，几乎必过
    const loud = createRhythm({ rng: seqRng([0, 0.999, 0.5]), now: clock.now, chattiness: 100 })
    expect(loud.decide({ isOwner: true })).toEqual({ thinkMs: 5000 })
  })

  it('isSelf → 一律 null，且不消耗任何 rng（防御性门禁）', () => {
    const clock = fakeClock()
    const rng = seqRng([0]) // 仅构造时的 streakLimit 首掷
    const r = createRhythm({ rng, now: clock.now })
    expect(r.decide({ isSelf: true, mentions: true, familyStreak: 100 })).toBe(null)
    expect(rng.count()).toBe(1)
  })
})

describe('createRhythm：门禁与判定顺序（冷却→AFK→预算→间隔→streak→概率）', () => {
  it('冷却对一切帧生效（含 mentions）；期满惰性转闲置 → AFK 掷骰（裁定 F2b）→ 放行', () => {
    const clock = fakeClock()
    // 构造 lim=6；触发冷却 30000；重掷 lim=8；期满 AFK 掷 0.5（miss）；mention 概率 0.5<0.9；think 0→2000
    const rng = seqRng([0, 0, 0.4, 0.5, 0.5, 0])
    const r = createRhythm({ rng, now: clock.now })

    expect(r.decide({ familyStreak: 6 })).toBe(null)
    expect(r.status()).toEqual({ cooldownUntil: 30000, afkUntil: null, hourCount: 0 })

    clock.set(29999)
    expect(r.decide({ mentions: true })).toBe(null) // 冷却不放行点名

    clock.set(30000)
    expect(r.decide({ mentions: true })).toEqual({ thinkMs: 2000 })
    expect(rng.count()).toBe(6) // 冷却中不掷任何骰；期满恰好 1 次 AFK 掷
  })

  it('AFK 中：非点名一律 null；mentions 仍放行；AFK 期满恢复正常档（裁定 F2a：noteSpoken 时掷）', () => {
    const clock = fakeClock()
    // 构造 lim=6；noteSpoken AFK 掷 0.1<0.15 命中 → afkMs 掷 0 → afkUntil=300000
    const rng = seqRng([0, 0.1, 0, 0.5, 0, 0.1, 0])
    const r = createRhythm({ rng, now: clock.now })
    r.noteSpoken()
    expect(r.status()).toEqual({ cooldownUntil: null, afkUntil: 300000, hourCount: 1 })

    clock.set(8000)
    expect(r.decide({})).toBe(null) // AFK 拦非点名
    expect(r.decide({ mentions: true })).toEqual({ thinkMs: 2000 }) // 点名放行

    clock.set(300000)
    expect(r.decide({})).toEqual({ thinkMs: 2000 }) // AFK 已过（human 档 0.1<0.4）
    expect(rng.count()).toBe(7)
  })

  it('小时预算：耗尽只放行 mentions；noteSpoken 推进 hourCount；跨 3600000ms 边界归零', () => {
    const clock = fakeClock()
    const rng = seqRng([0, 0.5, 0.5, 0.5, 0, 0.3, 0])
    const r = createRhythm({ rng, now: clock.now, params: { hourlyCap: 2 } })
    r.noteSpoken() // AFK 掷 0.5 miss
    r.noteSpoken() // AFK 掷 0.5 miss
    expect(r.status().hourCount).toBe(2)

    clock.set(8000)
    expect(r.decide({})).toBe(null) // 预算拦非点名
    expect(r.decide({ mentions: true })).toEqual({ thinkMs: 2000 }) // 点名仍可行

    clock.set(3600001)
    expect(r.status().hourCount).toBe(0) // 跨小时归零
    expect(r.decide({})).toEqual({ thinkMs: 2000 }) // 预算恢复
    expect(rng.count()).toBe(7)
  })

  it('距上条发言 < minGapMs(8000) → 一律 null（含 mentions）；≥8000 放行', () => {
    const clock = fakeClock()
    const rng = seqRng([0, 0.5, 0.5, 0])
    const r = createRhythm({ rng, now: clock.now })
    r.noteSpoken() // AFK 掷 0.5 miss

    clock.set(7999)
    expect(r.decide({ mentions: true })).toBe(null) // 间隔不放行点名
    clock.set(8000)
    expect(r.decide({ mentions: true })).toEqual({ thinkMs: 2000 })
    expect(rng.count()).toBe(4)
  })

  it('familyStreak 达本次 streakLimit → null + 进入冷却，且重掷缓存（7<新 8 放行，8 再触发）', () => {
    const clock = fakeClock()
    // 构造 lim=6；触发冷却 30000 并重掷 lim=8；期满 AFK miss；human 0.1 接受；think 0；
    // 二次触发冷却 30000（从 t=30000 起）并重掷
    const rng = seqRng([0, 0, 0.4, 0.5, 0.1, 0, 0, 0.4])
    const r = createRhythm({ rng, now: clock.now })

    expect(r.decide({ familyStreak: 6 })).toBe(null)
    expect(r.status().cooldownUntil).toBe(30000)

    clock.set(30000)
    expect(r.decide({ familyStreak: 7 })).toEqual({ thinkMs: 2000 }) // 新阈值 8：7 不触发
    expect(r.decide({ familyStreak: 8 })).toBe(null) // 8 ≥ 8：再触发
    expect(r.status().cooldownUntil).toBe(60000) // 30000 + between([30000,120000],0)=30000
    expect(rng.count()).toBe(8)
  })

  it('penalize() 把剩余冷却翻倍（B4）；无冷却时掷一个全新冷却', () => {
    const clock = fakeClock()
    const rng = seqRng([0, 0, 0.4])
    const r = createRhythm({ rng, now: clock.now })
    r.decide({ familyStreak: 6 }) // 冷却至 30000

    clock.set(10000) // 剩余 20000
    r.penalize()
    expect(r.status().cooldownUntil).toBe(50000) // 10000 + 20000×2

    clock.set(20000) // 剩余 30000
    r.penalize()
    expect(r.status().cooldownUntil).toBe(80000) // 20000 + 30000×2
    expect(rng.count()).toBe(3) // 翻倍路径不掷骰

    const fresh = createRhythm({ rng: seqRng([0, 0]), now: clock.now })
    fresh.penalize() // 无冷却 → between([30000,120000],0)=30000
    expect(fresh.status().cooldownUntil).toBe(20000 + 30000)
  })
})

describe('createRhythm：延迟与闲置接口', () => {
  it('typingDelay(100) ∈ [2000,4000]（每 50 字 ×between([1000,2000])）；0 字 → 0 不掷骰', () => {
    const clock = fakeClock()
    expect(createRhythm({ rng: seqRng([0, 0]), now: clock.now }).typingDelay(100)).toBe(2000)
    expect(createRhythm({ rng: seqRng([0, 0.5]), now: clock.now }).typingDelay(100)).toBe(3000)
    expect(createRhythm({ rng: seqRng([0, 1]), now: clock.now }).typingDelay(100)).toBe(4000)
    expect(createRhythm({ rng: seqRng([0, 0.5]), now: clock.now }).typingDelay(51)).toBe(3000)
    expect(createRhythm({ rng: seqRng([0, 0.5]), now: clock.now }).typingDelay(49)).toBe(1500)
    const zeroRng = seqRng([0]) // 只有构造首掷
    expect(createRhythm({ rng: zeroRng, now: clock.now }).typingDelay(0)).toBe(0)
  })

  it('thinkMs 端点：between([2000,8000]) → rng=0 得 2000、rng=1 得 8000（钳到闭区间）', () => {
    const clock = fakeClock()
    expect(createRhythm({ rng: seqRng([0, 0, 0]), now: clock.now }).decide({ mentions: true }))
      .toEqual({ thinkMs: 2000 })
    expect(createRhythm({ rng: seqRng([0, 0, 1]), now: clock.now }).decide({ mentions: true }))
      .toEqual({ thinkMs: 8000 })
  })

  it('canInitiateIdle：AFK/冷却/预算/最小间隔任一存在 → false（B21），空闲健康 → true', () => {
    // 全新引擎
    expect(createRhythm({ rng: seqRng([0]), now: fakeClock().now }).canInitiateIdle()).toBe(true)

    // 最小间隔
    const gapClock = fakeClock()
    const gap = createRhythm({ rng: seqRng([0, 0.5]), now: gapClock.now })
    gap.noteSpoken()
    gapClock.set(7999)
    expect(gap.canInitiateIdle()).toBe(false)
    gapClock.set(8000)
    expect(gap.canInitiateIdle()).toBe(true)

    // AFK
    const afkClock = fakeClock()
    const afk = createRhythm({ rng: seqRng([0, 0.1, 0]), now: afkClock.now })
    afk.noteSpoken() // 命中 AFK → 300000
    afkClock.set(1000)
    expect(afk.canInitiateIdle()).toBe(false)
    afkClock.set(300000)
    expect(afk.canInitiateIdle()).toBe(true)

    // 预算（t=8000 已越过最小间隔，false 只能来自 hourlyCap=1）
    const poorClock = fakeClock()
    const poor = createRhythm({
      rng: seqRng([0, 0.5]),
      now: poorClock.now,
      params: { hourlyCap: 1 },
    })
    poor.noteSpoken()
    poorClock.set(8000)
    expect(poor.canInitiateIdle()).toBe(false)

    // 冷却（期满惰性掷 AFK miss 后放行）
    const coolClock = fakeClock()
    const cool = createRhythm({ rng: seqRng([0, 0, 0.4, 0.5]), now: coolClock.now })
    cool.decide({ familyStreak: 6 })
    expect(cool.canInitiateIdle()).toBe(false)
    coolClock.set(30000)
    expect(cool.canInitiateIdle()).toBe(true)
  })

  it('rollIdle：idleBaseProb 0.3 × factor；chattiness=0 时 0.06', () => {
    const clock = fakeClock()
    expect(createRhythm({ rng: seqRng([0, 0.29]), now: clock.now }).rollIdle()).toBe(true)
    expect(createRhythm({ rng: seqRng([0, 0.3]), now: clock.now }).rollIdle()).toBe(false)
    expect(createRhythm({ rng: seqRng([0, 0.05]), now: clock.now, chattiness: 0 }).rollIdle()).toBe(true)
    expect(createRhythm({ rng: seqRng([0, 0.1]), now: clock.now, chattiness: 0 }).rollIdle()).toBe(false)
  })

  it('notifyActivity() 为接口兼容空操作（闲置窗口归 scheduler，见计划修正记录），不掷骰', () => {
    const clock = fakeClock()
    const rng = seqRng([0])
    const r = createRhythm({ rng, now: clock.now })
    r.notifyActivity()
    expect(rng.count()).toBe(1)
    expect(r.status()).toEqual({ cooldownUntil: null, afkUntil: null, hourCount: 0 })
  })

  it('status() 初始形状 + params 覆盖生效 + 默认参数冒烟（真实 Math.random 不炸）', () => {
    const clock = fakeClock()
    const r = createRhythm({ rng: seqRng([0]), now: clock.now })
    expect(r.status()).toEqual({ cooldownUntil: null, afkUntil: null, hourCount: 0 })

    // params.minGapMs 覆盖：默认 8000 → 1，noteSpoken 后 t=1 即放行
    const custom = createRhythm({
      rng: seqRng([0, 0.5, 0.3, 0]),
      now: clock.now,
      params: { minGapMs: 1 },
    })
    custom.noteSpoken() // AFK 掷 0.5 miss
    clock.set(1)
    expect(custom.decide({})).toEqual({ thinkMs: 2000 }) // human 档 0.3<0.4

    // 默认参数（真 Math.random / Date.now）冒烟：不抛，返回 null 或合法 thinkMs 区间
    const d = createRhythm()
    const out = d.decide({ mentions: true })
    expect(out === null || (typeof out.thinkMs === 'number' && out.thinkMs >= 2000 && out.thinkMs <= 8000)).toBe(true)
  })
})

describe('createIdleScheduler', () => {
  // between([180000,480000], 0)=180000；between([180000,480000],0.5)=330000；
  // between([480000,900000],0.5)=690000；between([480000,900000],0)=480000。
  // 两人洗牌（Fisher-Yates 单步）：rng<0.5 → 交换，rng≥0.5 → 保持 [a,b]。

  it('静默未满窗口 → tick 返回 null，不掷骰、不问候选', () => {
    const clock = fakeClock()
    const rng = seqRng([0]) // 仅构造开窗
    const s = createIdleScheduler({ rng, now: clock.now })
    const a = cand('a', true, true)
    clock.set(179999)
    expect(s.tick([a])).toBe(null)
    expect(a.canCount).toBe(0)
    expect(rng.count()).toBe(1)
  })

  it('到点按 rng 洗牌顺序取首个通过者（canInitiateIdle false 短路不掷 rollIdle）；成功后下窗口用 idleWindowAfterIdleMs', () => {
    const clock = fakeClock()
    // 窗1=180000；洗牌 0.6→[a,b]；胜利后窗2=690000；洗牌 0.4→[b,a]；胜利后窗3=480000
    const rng = seqRng([0, 0.6, 0.5, 0.4, 0])
    const s = createIdleScheduler({ rng, now: clock.now })
    const a = cand('a', false, true)
    const b = cand('b', true, true)

    clock.set(180000)
    expect(s.tick([a, b])).toBe('b')
    expect(a.canCount).toBe(1)
    expect(a.rollCount).toBe(0) // && 短路：can=false 不掷 roll

    clock.set(360000) // 若误用 afterChat(180000) 窗口此刻已到期
    expect(s.tick([a, b])).toBe(null)
    expect(b.canCount).toBe(1)

    clock.set(870000) // 180000 + 690000
    expect(s.tick([a, b])).toBe('b')
    expect(a.canCount).toBe(1) // 洗牌序 [b,a]，b 先胜，a 未被问

    clock.set(1349999) // 870000 + 480000 未到
    expect(s.tick([a, b])).toBe(null)
    expect(rng.count()).toBe(5)
  })

  it('掷骰全员未过 → null 静默放弃，按 afterChat 重新开窗，下一窗口再掷（B21）', () => {
    const clock = fakeClock()
    // 窗1=180000；洗牌 0.6；全败 → 窗2=180000；洗牌 0.6；全败 → 窗3 掷值
    const rng = seqRng([0, 0.6, 0, 0.6, 0])
    const s = createIdleScheduler({ rng, now: clock.now })
    const a = cand('a', true, false)
    const b = cand('b', true, false)

    clock.set(180000)
    expect(s.tick([a, b])).toBe(null)
    expect(a.rollCount).toBe(1) // can=true → 正常掷 roll（各自 1 次）
    expect(b.rollCount).toBe(1)

    clock.set(359999)
    expect(s.tick([a, b])).toBe(null)
    expect(a.canCount).toBe(1) // 窗口未到期不问候选

    clock.set(360000)
    expect(s.tick([a, b])).toBe(null)
    expect(a.canCount).toBe(2)
    expect(rng.count()).toBe(5)
  })

  it('notifyActivity(isFamily=true) 不缩短已武装窗口；isFamily=false 完全重置（终审 #7）', () => {
    // spec §7「发起后放宽 8~15min 控 token 下限」此前被自家消息秒腰斩——死条款。
    // 窗1=180000；winner → afterIdle 窗 2=180000+480000=660000；
    // 家族 notify 掷出 300000+between(afterChat,0)=480000 < 660000 → max 保留长窗。
    // 修复前 notifyActivity 无视参数直接重置 → 长窗被腰斩，t=500000 提前开火
    const clock = fakeClock()
    const rng = seqRng([0, 0, 0, 0, 0])
    const s = createIdleScheduler({ rng, now: clock.now })
    const w = cand('w', true, true)
    clock.set(180000)
    expect(s.tick([w])).toBe('w')

    clock.set(300000)
    s.notifyActivity(true)
    clock.set(500000)
    const q = cand('q', true, true)
    expect(s.tick([q])).toBe(null) // 长窗存活：不到点、不问候选、不掷骰
    expect(q.canCount).toBe(0)

    s.notifyActivity(false) // 真人消息 → 依旧完全重置：500000+180000=680000
    clock.set(679999)
    expect(s.tick([q])).toBe(null)
    clock.set(680000)
    expect(s.tick([q])).toBe('q') // 重置生效：到点开火 → afterIdle 再掷窗
    expect(rng.count()).toBe(5)
  })

  it('任一 notifyActivity 重置窗口（从当前时刻重新掷 afterChat 窗）', () => {
    const clock = fakeClock()
    // 窗1=180000；t=90000 重置 → 90000+330000=420000；洗牌 0.6；全败 → 掷窗值 0
    const rng = seqRng([0, 0.5, 0.6, 0])
    const s = createIdleScheduler({ rng, now: clock.now })
    const a = cand('a', false, false)
    const b = cand('b', false, false)

    clock.set(90000)
    s.notifyActivity()

    clock.set(180000) // 原窗口到期点：已重置，不该问候选
    expect(s.tick([a, b])).toBe(null)
    expect(a.canCount).toBe(0)

    clock.set(420000) // 新窗口到期点
    expect(s.tick([a, b])).toBe(null)
    expect(a.canCount).toBe(1)
    expect(rng.count()).toBe(4)
  })
})
