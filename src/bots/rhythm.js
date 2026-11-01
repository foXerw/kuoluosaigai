// 拟人节奏引擎（RhythmEngine，Task 2 / spec §7）：概率分档、思考/打字延迟、
// 对话预算（家族 streak → 冷却）、小时软上限、最小间隔、随机 AFK、闲置发起
// 掷骰与房间级闲置调度器。纯逻辑：rng / now 全部注入，无 IO、不依赖 Vue、
// 不 import ContextBuffer（trailingFamilyStreak 直接收 frames 数组，B18 隔离）。
//
// 设计钉死（对 Task 7/8 的契约，改动须同步 runner/store）：
// - decide 判定顺序 = 冷却→AFK→小时预算→最小间隔→streak→概率掷骰。
//   该顺序决定 rng 消耗次数（冷却/AFK/预算/间隔拦下时掷任何骰都不该发生），
//   测试用「逐值弹出」序列 rng 钉死，顺序变更会直接打破 rng 计数断言。
// - mentions（点名）只豁免 AFK 与小时预算两道门（spec §7：期间/超限"只回点名"），
//   冷却与最小间隔对一切帧生效（含点名）。
// - AFK 掷骰时机（裁定 F2）：(a) noteSpoken() 后；(b) 冷却期满转闲置时，由下一次
//   decide/status/canInitiateIdle/rollIdle 惰性检测。各以 afkRollProb 掷，命中则
//   afkUntil = now + between(afkMs)。scheduler 不再参与 AFK（家族级 vs bot 级）。
// - streakLimit 在 createRhythm 构造时首掷缓存（消耗 1 次 rng）；触发冷却（streak
//   归零）后重掷并缓存，实现"每轮对话换一个随机阈值"。
// - thinkMs + typingDelay 的合计封顶（totalDelayCapMs=15000）由调用方（Task 7
//   runner）负责，本模块只产出各自的分量。

/** 钉死常量 = spec §7；store（Task 8）与 UI 展示同源引用。区间值均为 [lo, hi] 闭区间毫秒/次数。 */
export const RHYTHM_DEFAULTS = {
  replyBase: { mention: 0.9, owner: 0.7, human: 0.4, bot: 0.2 }, // isSelf 由调用方先滤，不进 decide
  thinkMs: [2000, 8000],
  typingMsPer50: [1000, 2000], totalDelayCapMs: 15000,
  streakLimit: [6, 10],        // 每次 streak 归零时重掷
  cooldownMs: [30000, 120000],
  hourlyCap: 30,               // 超限只回 mentions
  minGapMs: 8000,
  afkRollProb: 0.15, afkMs: [300000, 1200000],   // 冷却结束/闲置重新武装时掷
  idleBaseProb: 0.3,
  idleWindowAfterChatMs: [180000, 480000],       // 3~8min
  idleWindowAfterIdleMs: [480000, 900000],       // 8~15min
  idleCheckMs: 15000,
}

// 话痨度系数（设计者裁定）：factor = 0.2 + 1.6 * (chattiness / 100)，最终概率 clamp [0,1]
// chattiness 50 = 1.0x 基准；0 = 0.2x（不完全闭嘴）；100 = 1.8x
const HOUR_MS = 3600000

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

/** 闭区间均匀整数掷值：lo + floor(rng()*(hi-lo+1))，rng 接近 1 时钳到 hi。 */
function between(rng, [lo, hi]) {
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)))
}

/** Fisher–Yates（消耗 n-1 次 rng；n≤1 不掷）。就地打乱传入副本。 */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/**
 * 从帧序列尾部数「我方家族」连续发言条数（对话预算口径：只认我方 bot nick 集合，
 * 陌生人 BOT· badge 不计——spec §7 builder-check Q3）。
 * @param {Array<{nick: string}>} frames 时间升序帧（形状不透明，只看 nick）
 * @param {Set<string>} familyNicks 我方 bot 的 ANON nick 集合
 * @returns {number} 末尾连续命中条数；空/缺输入 → 0
 */
export function trailingFamilyStreak(frames, familyNicks) {
  let streak = 0
  for (let i = (frames ? frames.length : 0) - 1; i >= 0; i--) {
    const f = frames[i]
    if (f && familyNicks.has(f.nick)) streak++
    else break
  }
  return streak
}

/**
 * 创建单 bot 节奏引擎。
 * @param {{
 *   rng?: () => number,
 *   now?: () => number,
 *   chattiness?: number,
 *   params?: Partial<typeof RHYTHM_DEFAULTS>,
 * }} [options] params 浅覆盖 RHYTHM_DEFAULTS。注意：构造即消耗 1 次 rng（streakLimit 首掷）。
 */
export function createRhythm({
  rng = Math.random,
  now = () => Date.now(),
  chattiness = 50,
  params = {},
} = {}) {
  const p = { ...RHYTHM_DEFAULTS, ...params }
  const factor = 0.2 + 1.6 * (chattiness / 100)

  let cooldownUntil = null
  let afkUntil = null
  let lastSpokenAt = null
  let hourStart = now()
  let hourCount = 0
  let streakLimit = between(rng, p.streakLimit)

  function settleHour(t) {
    if (t - hourStart >= HOUR_MS) {
      hourStart = t
      hourCount = 0
    }
  }

  /** 掷一次 AFK 骰（裁定 F2 公共路径）：消耗 1 rng（概率），命中再 +1（时长）。 */
  function rollAfk(t) {
    if (rng() < p.afkRollProb) afkUntil = t + between(rng, p.afkMs)
  }

  /** 惰性结算：小时滚动 + 冷却期满转闲置（此时掷 AFK 骰，裁定 F2b）。 */
  function settle(t) {
    settleHour(t)
    if (cooldownUntil !== null && t >= cooldownUntil) {
      cooldownUntil = null
      rollAfk(t)
    }
  }

  return {
    /**
     * 对一条入站消息决定是否接话。判定顺序钉死（影响 rng 消耗，见头部注释）。
     * familyStreak 由调用方（Task 7）每帧用 trailingFamilyStreak 现算传入（裁定 F1）。
     * @param {{ mentions?: boolean, isOwner?: boolean, isFamily?: boolean,
     *   isSelf?: boolean, familyStreak?: number }} input
     * @returns {null | { thinkMs: number }} 命中 → 思考时长；打字延迟由调用方
     *   typingDelay 取得并自行按 totalDelayCapMs 合计封顶。
     */
    decide({
      mentions = false,
      isOwner = false,
      isFamily = false,
      isSelf = false,
      familyStreak = 0,
    } = {}) {
      if (isSelf) return null // 防御性自激门禁（B3 调用方本应先滤）
      const t = now()
      settle(t)
      if (cooldownUntil !== null) return null // 家族冷却：点名也不放行的 bot 级静默
      if (!mentions && afkUntil !== null && t < afkUntil) return null
      if (!mentions && hourCount >= p.hourlyCap) return null
      if (lastSpokenAt !== null && t - lastSpokenAt < p.minGapMs) return null
      if (familyStreak >= streakLimit) {
        // streak 归零：进家族冷却并重掷下一轮阈值（缓存）
        cooldownUntil = t + between(rng, p.cooldownMs)
        streakLimit = between(rng, p.streakLimit)
        return null
      }
      const base = mentions
        ? p.replyBase.mention
        : isOwner
          ? p.replyBase.owner
          : isFamily
            ? p.replyBase.bot
            : p.replyBase.human
      if (rng() >= clamp01(base * factor)) return null
      return { thinkMs: between(rng, p.thinkMs) }
    },

    /**
     * 打字模拟延迟：ceil(textLen/50) 段 × between(typingMsPer50)。
     * textLen≤0 → 0 且不掷骰。与 thinkMs 的合计封顶由调用方负责。
     */
    typingDelay(textLen) {
      const units = Math.max(0, Math.ceil((textLen || 0) / 50))
      if (units === 0) return 0
      return units * between(rng, p.typingMsPer50)
    },

    /** 记录「本 bot 真的发了一条消息」：推进小时计数、刷新最小间隔、掷 AFK 骰（裁定 F2a）。 */
    noteSpoken() {
      const t = now()
      settle(t)
      hourCount += 1
      lastSpokenAt = t
      rollAfk(t)
    },

    /**
     * rate 帧退避（B4）：已有剩余冷却 → 剩余翻倍；冷却刚过期/无冷却 → 掷一个全新
     * 随机冷却（保证收到限频必然得到实际退避，rng 消耗 +1）。
     */
    penalize() {
      const t = now()
      settle(t)
      const remaining = cooldownUntil !== null ? Math.max(0, cooldownUntil - t) : 0
      cooldownUntil = t + (remaining > 0 ? remaining * 2 : between(rng, p.cooldownMs))
    },

    /**
     * 闲置发起资格门禁（B21：AFK/冷却/小时预算/最小间隔照常约束）。
     * 不掷骰（settle 惰性 AFK 结算除外）。
     */
    canInitiateIdle() {
      const t = now()
      settle(t)
      if (cooldownUntil !== null) return false
      if (afkUntil !== null && t < afkUntil) return false
      if (hourCount >= p.hourlyCap) return false
      if (lastSpokenAt !== null && t - lastSpokenAt < p.minGapMs) return false
      return true
    },

    /** 闲置发起掷骰：idleBaseProb × factor，消耗 1 次 rng。 */
    rollIdle() {
      return rng() < clamp01(p.idleBaseProb * factor)
    },

    /**
     * 兼容接口位（Task 7/8 签名）：闲置窗口管理已上移到家族级 createIdleScheduler
     * （见计划修正记录），bot 级无「房内活动」状态需维护 → 空操作，不掷骰。
     */
    notifyActivity() {},

    /**
     * 只读视图（store 展示 / runner 上报用）。注意有副作用：惰性结算小时窗口与
     * 冷却期满（可能触发一次 AFK 掷骰）。
     * @returns {{ cooldownUntil: number|null, afkUntil: number|null, hourCount: number }}
     */
    status() {
      const t = now()
      settle(t)
      return { cooldownUntil, afkUntil, hourCount }
    },
  }
}

/**
 * 房间级闲置发起调度器（家族协调：静默开窗 → 到点随机顺序掷骰 → 首个通过者发起）。
 * 与 bot 级 AFK/预算门禁通过 candidates 注入回调解耦（Task 8 store 组装）。
 * @param {{ rng?: () => number, now?: () => number, params?: object }} [options]
 *   注意：构造即消耗 1 次 rng（首个 afterChat 窗口）。
 * @returns {{
 *   notifyActivity: () => void,
 *   tick: (candidates: Array<{ id: string, canInitiateIdle: () => boolean, rollIdle: () => boolean }>)
 *     => string | null,
 * }}
 */
export function createIdleScheduler({
  rng = Math.random,
  now = () => Date.now(),
  params = {},
} = {}) {
  const p = { ...RHYTHM_DEFAULTS, ...params }

  const rollWindow = (key) => now() + between(rng, p[key])
  let windowUntil = rollWindow('idleWindowAfterChatMs')

  return {
    /** 房内任何消息（含自家 bot 的）→ 重新武装 afterChat 窗口（消耗 1 次 rng）。 */
    notifyActivity() {
      windowUntil = rollWindow('idleWindowAfterChatMs')
    },

    /**
     * 周期检查（Task 8 以 idleCheckMs=15000 间隔驱动）。
     * 未到期 → null 且不消耗 rng、不询问候选；到期 → Fisher–Yates 洗牌（n-1 次 rng）
     * 后按序取首个 `canInitiateIdle() && rollIdle()` 通过者（短路：资格不过不掷它的
     * rollIdle）。成功 → 下窗口换 afterIdle（更长，控 token）；全员未过 → 静默放弃、
     * 按 afterChat 重新开窗，下一窗口再掷（B21，不立即重试）。
     */
    tick(candidates) {
      if (now() < windowUntil) return null
      const order = shuffle([...(candidates || [])], rng)
      for (const c of order) {
        if (c.canInitiateIdle() && c.rollIdle()) {
          windowUntil = rollWindow('idleWindowAfterIdleMs')
          return c.id
        }
      }
      windowUntil = rollWindow('idleWindowAfterChatMs')
      return null
    },
  }
}
