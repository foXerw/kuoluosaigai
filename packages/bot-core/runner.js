// BotRunner（Task 7 / spec §8.3、§9）：单 bot 编排器——把 connection/buffer/rhythm/
// prompt/llm 串成完整发言管道：入站帧处置 → 决策 → 延迟 → LLM → 发送 → 记账上报。
// Task 8（store）经 onState/onEvent 消费本模块，不直接触碰内部。
//
// 设计钉死（计划 Step 3）：
// - 单发言队列：speaking 布尔 + pendingJob 至多 1；在途期间新命中占住 pending 槽，
//   槽已占则直接丢弃（B10 每 bot 同时最多 1 个在途 LLM 请求由 runJob 串行保证）。
// - 发送前双保险：roomEpoch（切房/stop 递增，在途响应回来先作废）+
//   frame.roomId === connection.currentRoomId（B7）。
// - familyStreak 每帧用 trailingFamilyStreak(buffer.all(), familySet) 现算传入 decide。
// - mentions = text 含 bot.name 子串、大小写不敏感。
// - 总延迟 = thinkMs 先睡 → LLM → typingDelay(回复长度) 补足封顶差额再睡
//   （Math.min(think+typing, totalDelayCapMs) 由这里执行，rhythm 只产分量；
//   打字时长必须知道回复长度，故拆两段，合计仍 ≤15000）。
// - 自家发言服务器会回显（sendToRoom 不 except 发送者），B3 一律丢弃回显；
//   发送成功时自推一条 local-* 镜像帧进 buffer，保证 LLM 上下文含自己的话、
//   家族 streak 与冷却计量正确。
// - history 窗口镜像 useChat.openHistoryWindow（2000ms、逐帧 roomId 双校验、
//   切房/重进即关窗），但 merge 结果进自己的 ContextBuffer（B2，不碰 roomCache）。
// - provider 配置校验在这里做（llm 对缺失配置会拼垃圾 URL 静默请求）：
//   baseUrl/apiKey/model 缺失 → 直接 error 状态不连接。
// - B9 红线：所有 error 文案经 redact() 兜底剥离 apiKey 子串；stop 原因均为
//   固定安全文案（SLOW DOWN / NO SUCH ROOM / ROOM FULL / TOKEN 失效 / 配置缺失）。
// - B11：退避重连与 rejoin 是 connection 的职责；runner 只在 onStatus 变化时镜像
//   连接态，joined 回执清 rateStreak/冷却显示、rhythm 实例原样保留（预算/间隔连续）。
// B18：不 import useChat/roomCache/roomList；唯一跨界依赖 mergeHistory（spec B2 明示允许）。

import { createContextBuffer } from './buffer.js'
import { createRhythm, trailingFamilyStreak, RHYTHM_DEFAULTS } from './rhythm.js'
import { buildSystemPrompt, buildMessages, clampText } from './prompt.js'
import { chatCompletion, LlmError } from './llm.js'
import { createBotConnection } from './connection.js'
import { mergeHistory } from './historyMerge.js'

const HISTORY_WINDOW_MS = 2000 // 与 useChat 同值：history-res 收集窗口
const HISTORY_RES_MAX = 200 // B2：合并/应答上限
const JOIN_RETRY_MS = 1000 // B5：join-error 重试间隔
const JOIN_RETRY_MAX = 3 // B5：至多重试 3 次（第 4 个 join-error 停用）
const RATE_STOP_AT = 3 // B4：连续 3 个 rate 停用亮红
const PROMPT_WINDOW = 40 // buildMessages 上下文条数（§8.1 30~50 取中）

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function between(rng, [lo, hi]) {
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)))
}

/**
 * 创建单 bot 编排器。
 * @param {{
 *   bot: { id: string, name: string, persona: string, chattiness: number, model: string,
 *          temperature: number, rawPrompt?: string, roomId: string, nick?: string|null },
 *   provider: { baseUrl: string, apiKey: string },
 *   wsUrl: string,
 *   getOwnerNick?: () => string|null,
 *   getFamilyNicks?: () => Iterable<string>,
 *   rng?: () => number, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch,
 *   onState?: (patch: object) => void,
 *   onEvent?: (type: 'activity'|'nick'|'stopped', payload?: any) => void,
 * }} options
 * @returns {{ start: () => void, stop: (reason?: string) => void,
 *   switchRoom: (roomId: string) => void, clearBuffer: () => void,
 *   getBuffer: () => object[], pokeIdle: (opts?: { preRolled?: boolean }) => void,
 *   idleEligible: () => boolean, idleRoll: () => boolean, getState: () => object }}
 */
export function createBotRunner({
  bot,
  provider,
  wsUrl,
  getOwnerNick,
  getFamilyNicks,
  rng = Math.random,
  now = Date.now,
  sleep = defaultSleep,
  WebSocketImpl,
  fetchImpl = globalThis.fetch,
  onState,
  onEvent,
}) {
  const buffer = createContextBuffer()
  const badge = `BOT·${String(bot.name ?? '').slice(0, 12)}` // 全局约束：人格名 ≤12 截断
  const systemPrompt = buildSystemPrompt({ name: bot.name, persona: bot.persona, override: bot.rawPrompt })

  let rhythm = null
  let connection = null
  let started = false
  let fatal = false // stop 时状态亮 error 还是 stopped
  let transport = 'connecting' // connection 最新上报
  let cooling = false // rate 帧驱动的节奏冷却（显示态；rhythm 内部另有权威 cooldownUntil）
  let emittedStatus = null
  let errorText = null

  let rev = 0
  let session = { promptTokens: 0, completionTokens: 0, messages: 0 }
  let hourCount = 0
  let nick = typeof bot.nick === 'string' && bot.nick ? bot.nick : null
  let selfId = null

  let rateStreak = 0
  let joinErrors = 0
  let joinRetryTimer = null
  let histWindow = null

  let speaking = false
  let pendingJob = null
  let lastSentAt = null // 终审 #5：上一条实际发送时刻——minGap 约束的是发送时刻而非命中时刻
  let roomEpoch = 0 // 切房/stop 递增：在途 runJob 回来发现 epoch 变了即作废（B7）
  let synthSeq = 0

  function patch(fields) {
    if (onState) onState({ rev, ...fields })
  }

  /** B9：error 文案兜底剥离 apiKey 子串（正常路径文案本就无 key，防御层不嫌多）。 */
  function redact(s) {
    const t = String(s ?? '')
    const key = provider && provider.apiKey
    return key && t.includes(key) ? t.split(key).join('[redacted]') : t
  }

  function effectiveStatus() {
    if (!started) return fatal ? 'error' : 'stopped'
    if (cooling) return 'cooling'
    return transport === 'open' ? 'open' : 'connecting'
  }

  function pushStatus() {
    const s = effectiveStatus()
    if (s === emittedStatus) return
    emittedStatus = s
    patch({ status: s })
  }

  function familySet() {
    return new Set(getFamilyNicks ? getFamilyNicks() : [])
  }

  function clearJoinRetry() {
    if (joinRetryTimer != null) {
      clearTimeout(joinRetryTimer)
      joinRetryTimer = null
    }
  }

  function closeHistoryWindow() {
    if (!histWindow) return
    clearTimeout(histWindow.timer)
    histWindow = null
  }

  // —— 镜像 useChat.openHistoryWindow：到点把收集响应 merge 进自家 buffer ——
  function openHistoryWindow(roomId) {
    closeHistoryWindow()
    const responses = []
    const timer = setTimeout(() => {
      histWindow = null
      const merged = mergeHistory(buffer.all(), responses, { maxPerRoom: HISTORY_RES_MAX })
      buffer.replace(merged)
      rev += 1
      if (started) patch({ rev })
    }, HISTORY_WINDOW_MS)
    histWindow = { roomId, responses, timer }
  }

  function respondHistoryReq(frame) {
    if (!connection) return
    const to = frame.from
    // 协议红线（同 useChat）：绝不回给自家 selfId——服务器原路回显成环
    if (to == null || to === selfId) return
    if (frame.roomId !== connection.currentRoomId) return
    const msgs = buffer.all()
    if (!msgs.length) return
    connection.send({
      type: 'history-res',
      roomId: frame.roomId,
      to,
      messages: msgs.slice(-HISTORY_RES_MAX),
    })
  }

  function handleJoinError(frame) {
    const text = frame.reason === 'full' ? 'ROOM FULL' : 'NO SUCH ROOM'
    if (joinErrors >= JOIN_RETRY_MAX) {
      stop(text, true)
      return
    }
    joinErrors += 1
    clearJoinRetry()
    joinRetryTimer = setTimeout(() => {
      joinRetryTimer = null
      if (!started || !connection) return
      connection.send({ type: 'join', roomId: connection.currentRoomId })
    }, JOIN_RETRY_MS)
  }

  function handleMessage(frame) {
    // 防御性双保险（同 useChat 仅当前房入缓冲）：非当前房帧直接丢
    if (frame.roomId !== connection.currentRoomId) return
    // B3：自己的帧绝不处理——不回显入缓冲、不触发决策（自家发言由发送侧镜像入 buffer）
    if (nick && frame.nick === nick) return

    const text = typeof frame.text === 'string' ? frame.text : ''
    const mentions = !!bot.name && text.toLowerCase().includes(String(bot.name).toLowerCase())
    const fam = familySet()
    const owner = getOwnerNick ? getOwnerNick() : null

    buffer.push(frame)
    rev += 1
    patch({ rev })
    // 终审 #7 接线：family 标志 = 自己观察到的家族成员消息（自家发送在 runJob 上报）
    onEvent?.('activity', { roomId: frame.roomId, family: fam.has(frame.nick) })

    const decision = rhythm.decide({
      mentions,
      isOwner: !!owner && frame.nick === owner,
      // 终审 #4（spec §7「其他 bot ~20%」）：概率档认公开 badge——陌生 BOT· 发送者
      // 不该拿 40% 真人档。familyStreak 预算计数保持 nick-only：badge 可伪造，
      // 只降概率档不放行冷却预算，伪造者被更少理睬，符合信任模型。
      isFamily: fam.has(frame.nick) || String(frame.badge || '').startsWith('BOT·'),
      familyStreak: trailingFamilyStreak(buffer.all(), fam),
    })
    if (decision) kick({ idle: false, thinkMs: decision.thinkMs, frame })
  }

  // —— 单发言队列：speaking 布尔 + pendingJob 至多 1 ——
  function kick(job) {
    if (speaking) {
      if (pendingJob === null) pendingJob = job // 槽已占：新命中直接丢弃，不排多条
      return
    }
    void runJob(job).catch(() => {}) // 终审 #6：管道异常兜底，不产 unhandled rejection
  }

  async function runJob(job) {
    speaking = true
    const epoch = roomEpoch
    try {
      await sleep(job.thinkMs) // 思考延迟（注入 sleep：假时钟可停可推）
      if (!started || epoch !== roomEpoch) return // 等待期间停/切房 → LLM 都不必发
      let res
      try {
        res = await chatCompletion({
          provider,
          model: bot.model,
          temperature: bot.temperature,
          messages: buildMessages({
            system: systemPrompt,
            frames: buffer.all(),
            selfNick: nick,
            idle: job.idle,
            window: PROMPT_WINDOW,
          }),
          fetchImpl,
          sleep, // 429/5xx 重试延迟同样走注入 sleep
        })
      } catch (err) {
        // B8/B9 分级：auth → 立即停用亮红；其余 kind → 本次放弃、bot 继续运行
        if (err instanceof LlmError && err.kind === 'auth') stop('TOKEN 失效', true)
        return
      }
      // B7 双保险其一：在途期间切房/停机 → 响应作废（连打字延迟都不掷）
      if (!started || epoch !== roomEpoch) return
      const text = clampText(res.text) // B6：发送前必截（llm 只 trim 不截断）
      if (!text) return // B6：空回复不发
      const typing = rhythm.typingDelay(text.length)
      // 合计封顶 Math.min(think+typing, 15000)：第二段只补差值
      await sleep(Math.max(0, Math.min(typing, RHYTHM_DEFAULTS.totalDelayCapMs - job.thinkMs)))
      if (!started || epoch !== roomEpoch) return
      // B7 双保险其二：触发帧所在房必须仍是当前房
      if (job.frame && job.frame.roomId !== connection.currentRoomId) return
      if (!connection.send({ type: 'message', text, badge })) return // 非 open 静默放弃

      // —— 发送成功记账 ——
      lastSentAt = now() // 终审 #5：排队轰炸防御的锚点
      synthSeq += 1
      buffer.push({
        type: 'message',
        // bot.id 段防家族跨 bot 撞号——否则两 bot 各有 local-1 且内容不同，
        // 响应 history-req 时被 mergeHistory 误判「同 id 跨响应者冲突」双双丢弃（审查轮 1）
        id: `local-${bot.id}-${synthSeq}`, // local- 前缀与服务器 id 命名空间隔离；服务器回显走 B3 丢弃不重复
        ts: now(),
        roomId: connection.currentRoomId,
        nick,
        badge,
        text,
      })
      rev += 1
      rhythm.noteSpoken() // 小时计数/最小间隔/AFK 掷骰推进（rhythm 内部记 rng 顺序）
      rateStreak = 0 // 成功发言打断 rate 连续计数（B4「连续」口径）
      cooling = false
      session = {
        promptTokens: session.promptTokens + res.promptTokens,
        completionTokens: session.completionTokens + res.completionTokens,
        messages: session.messages + 1,
      }
      hourCount = rhythm.status().hourCount
      patch({ rev, session: { ...session }, hourCount })
      pushStatus()
      // 自家消息 = 家族活动（终审 #7）：调度器对家族消息走 max 语义，不腰斩 idle 长窗
      onEvent?.('activity', { roomId: connection.currentRoomId, family: true })
    } finally {
      speaking = false
      const next = pendingJob
      pendingJob = null
      // 终审 #5：spec §7 最小间隔约束实际发送时刻——距上条发送 < minGapMs 时
      // 直接丢弃排队 job（风暴场景下 think+LLM 只要 3~5s，立即消费会击穿 8s 底线）
      if (next && started && (lastSentAt === null || now() - lastSentAt >= RHYTHM_DEFAULTS.minGapMs)) {
        void runJob(next).catch(() => {}) // 串行消费 pending；停机/间隔未足后丢弃。终审 #6 兜底异常
      }
    }
  }

  function handleFrame(frame) {
    if (!started || !frame || typeof frame.type !== 'string') return
    switch (frame.type) {
      case 'assign':
        if (typeof frame.nick === 'string' && frame.nick) {
          nick = frame.nick
          patch({ nick })
          onEvent?.('nick', { nick }) // store 持久化进配置：身份跨刷新延续
        }
        return
      case 'joined':
        selfId = frame.selfId
        joinErrors = 0
        clearJoinRetry()
        cooling = false // B11：重进房冷却显示重置（rhythm 实例与预算状态原样保留）
        rateStreak = 0
        patch({ roomId: frame.roomId })
        pushStatus()
        closeHistoryWindow() // 切房/重进一律取消旧窗口（同 useChat：迟到响应作废）
        if (frame.online > 1) {
          connection.send({ type: 'history-req' }) // B2：房内还有别人才值得要历史
          openHistoryWindow(frame.roomId)
        }
        return
      case 'join-error':
        handleJoinError(frame)
        return
      case 'message':
        handleMessage(frame)
        return
      case 'rate':
        rhythm.penalize() // B4：翻倍或掷全新冷却
        rateStreak += 1
        if (rateStreak >= RATE_STOP_AT) {
          stop('SLOW DOWN', true)
          return
        }
        cooling = true
        pushStatus()
        return
      case 'history-req':
        respondHistoryReq(frame)
        return
      case 'history-res':
        if (!histWindow) return // 迟到（窗口已关）响应
        if (frame.roomId !== connection.currentRoomId) return // Review Focus 4：跨房污染
        if (frame.roomId !== histWindow.roomId) return
        histWindow.responses.push(frame)
        return
      // presence/join/leave/counts/created/error/未知帧：静默忽略（同 v1，bot 无系统行视图）
    }
  }

  function handleStatus(next) {
    transport = next
    if (!started) return
    pushStatus()
  }

  function start() {
    if (started) return
    // 配置校验归 runner（llm 对缺失配置会拼垃圾 URL 静默请求）：缺件直接 error 不连接
    const missing = []
    if (!provider || typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) missing.push('baseUrl')
    if (!provider || typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) missing.push('apiKey')
    if (typeof bot.model !== 'string' || !bot.model.trim()) missing.push('model')
    if (missing.length) {
      fatal = true
      errorText = redact(`配置缺失：${missing.join('、')}`)
      emittedStatus = 'error'
      patch({ status: 'error', error: errorText })
      onEvent?.('stopped', errorText)
      return
    }
    started = true
    fatal = false
    errorText = null
    rateStreak = 0
    joinErrors = 0
    rhythm = createRhythm({ rng, now, chattiness: bot.chattiness })
    connection = createBotConnection({
      url: wsUrl,
      storedNick: nick,
      WebSocketImpl,
      onFrame: handleFrame,
      onStatus: handleStatus,
    })
    connection.connect(bot.roomId)
    pushStatus()
  }

  function stop(reason, isFatal = false) {
    if (!started) return
    started = false
    fatal = isFatal
    roomEpoch += 1 // 在途 runJob 回来即作废
    pendingJob = null
    clearJoinRetry()
    closeHistoryWindow()
    errorText = isFatal ? redact(reason) : null
    if (connection) connection.close() // 先置 started=false：onStatus('closed') 不再镜像连接态
    emittedStatus = isFatal ? 'error' : 'stopped'
    patch({ status: emittedStatus, error: errorText })
    onEvent?.('stopped', reason ?? null)
  }

  function switchRoom(roomId) {
    if (!started || !connection) return
    if (typeof roomId !== 'string' || roomId === '') return
    roomEpoch += 1 // B7：在途响应即刻作废
    pendingJob = null
    closeHistoryWindow()
    buffer.clear() // 换房换上下文
    rev += 1
    connection.switchRoom(roomId) // closed 态只记账，下次 open 由 connection 统一 join（B11）
    patch({ rev })
  }

  function clearBuffer() {
    buffer.clear()
    rev += 1
    patch({ rev })
  }

  /**
   * 闲置发起资格查询（审查轮 1 #1，供 Task 8 store 调度器 candidates 代理）：
   * transport open && rhythm B21 门禁。不掷骰（settle 惰性 AFK 结算除外）。
   */
  function idleEligible() {
    if (!started || !rhythm) return false
    return transport === 'open' && rhythm.canInitiateIdle()
  }

  /**
   * 权威闲置掷骰（同上供 candidates 代理）：恰 1 次 rng（含 chattiness 系数）。
   * store 问过 true 后应以 pokeIdle({preRolled:true}) 发起，避免二次掷平方化概率。
   */
  function idleRoll() {
    if (!rhythm) return false
    return rhythm.rollIdle()
  }

  /**
   * 发起一次闲置发言。
   * @param {{ preRolled?: boolean }} [opts] preRolled=true：调用方（store 调度器）
   *   已依次问过 idleEligible + idleRoll，此处跳过内部门禁与掷骰（transport 门禁保留）
   *   直接走发起管道；无参调用行为与既往完全一致（向后兼容）。
   */
  function pokeIdle(opts = {}) {
    if (!started || !rhythm || !connection) return
    if (transport !== 'open') return // 连接未开：不发请求白烧 token（preRolled 同样保留此门禁）
    if (!opts.preRolled) {
      // B21 门禁：AFK/冷却/小时预算/最小间隔任一命中即静默（不掷 rollIdle、不消耗 rng）
      if (!rhythm.canInitiateIdle()) return
      if (!rhythm.rollIdle()) return
    }
    // 同管道但 idle=true：思考时长走 rhythm 同款 thinkMs 区间
    kick({ idle: true, thinkMs: between(rng, RHYTHM_DEFAULTS.thinkMs), frame: null })
  }

  function getState() {
    return {
      started,
      status: effectiveStatus(),
      error: errorText,
      nick,
      roomId: connection ? connection.currentRoomId : bot.roomId,
      session: { ...session },
      hourCount,
      rev,
    }
  }

  return {
    start,
    stop: (reason) => stop(reason, false),
    switchRoom,
    clearBuffer,
    getBuffer: () => buffer.all(),
    pokeIdle,
    idleEligible,
    idleRoll,
    getState,
  }
}
