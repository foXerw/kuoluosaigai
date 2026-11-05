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
// Q7（P1 Task 1 观测端口）：B8 旧口径静默吞掉的非致命 LlmError 与降级停用（SLOW DOWN /
// join 重试耗尽）现补发观测事件，供宿主（daemon logger）识别「哑巴 bot」：
// - onEvent('error', { kind, message, fatal })：catch 分支每条 LlmError 必发；kind 取
//   LlmError.kind，message 取 LlmError.message（经 redact 兜底，B9 已保证不含 apiKey）。
//   auth → fatal:true（照旧停用亮红），其余 kind → fatal:false（照旧本次放弃）。
// - onEvent('warn', { reason })：重试耗尽 / SLOW DOWN 等降级停用，先于既有 stopped 发。
// 非 LlmError 异常一律不 widening：不拼响应体 / 请求配置 / err.detail。
// 浏览器宿主未接线这些事件也无害（onEvent 是端口，发了没人听 = 现状）。
// B18：不 import useChat/roomCache/roomList——搬家后 core 零跨界依赖
// （mergeHistory 已随包内化为例行相对导入 ./historyMerge.js，spec B2 白名单使命完成）。

import { createContextBuffer } from './buffer.js'
import { createRhythm, trailingFamilyStreak, RHYTHM_DEFAULTS } from './rhythm.js'
import { buildSystemPrompt, buildMessages, buildTranscriptMessages, clampText } from './prompt.js'
import { planReply, sampleTargetLength, HUMANIZE_DEFAULTS } from './humanize.js'
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
 *          temperature: number, rawPrompt?: string, roomId: string, nick?: string|null,
 *          hourlyBudget?: number|null }, // R24：有限值 → rhythm params.hourlyCap；null/缺省 → 30
 *   provider: { baseUrl: string, apiKey: string },
 *   wsUrl: string,
 *   getOwnerNick?: () => string|null,
 *   getFamilyNicks?: () => Iterable<string>,
 *   rng?: () => number, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch,
 *   onState?: (patch: object) => void,
 *   onEvent?: (type: 'activity'|'nick'|'stopped'|'error'|'warn', payload?: any) => void,
 *     // Q7 观测事件：'error' → {kind, message, fatal}；'warn' → {reason}（降级停用报因）
 *   gate?: { allowSpeak: (mentions?: boolean) => boolean, quietNow?: () => boolean },
 *     // Q9/§12 schedule 刹车（P1 Task 2）：deck 由 opts.schedule 建 createGate 透传；
 *     // 缺省（浏览器/未配置）→ 现状行为逐字节不变。quietNow 供 P4 迷糊层判定。
 *   humanize?: boolean, // P4：缺省 false（runner 直连用户保持旧行为；deck 真实宿主默认 true）
 *   humanizeRng?: () => number, // P4：独立随机流，绝不复用 rhythm 的 rng（旧逐值断言依赖它）
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
  gate, // Q9/§12 schedule 刹车端口（deck 注入；缺省 → 现状行为）
  humanize = false, // P4：拟人管道（transcript/目标长度/沉默/分段/语气/迷糊）
  humanizeRng = Math.random, // P4：独立随机流，避免扰动 rhythm 的注入 rng 序列
}) {
  const buffer = createContextBuffer()
  const badge = `BOT·${String(bot.name ?? '').slice(0, 12)}` // 全局约束：人格名 ≤12 截断
  // P4：few-shot 随 humanize 开关走——humanize:false 的直连消费者拿到逐字节旧 system prompt。
  const systemPrompt = buildSystemPrompt({
    name: bot.name,
    persona: bot.persona,
    override: bot.rawPrompt,
    fewShot: humanize,
  })

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
      onEvent?.('warn', { reason: text }) // Q7：重试耗尽降级停用，报因先于 stopped
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
    // 终审 #7 接线：family 标志 = 自己观察到的家族成员消息（自家发送在 runJob 上报）。
    // R12：观察侧不带 sent——回声不是本 bot 的发送，不入全局小时闸的账。
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
    // Q9/§12 刹车（P1 Task 2）：decide 照常问 rhythm（冷却/streak/预算记账与掷骰
    // 时序不变），命中后、kick 前问 gate——静默窗内非点名不开口（不调 LLM、不发送）。
    // 点名放行由 gate.allowSpeak(true) 决定（Q9 精确化；Task 3 全局闸满时点名也拦）。
    // gate 缺省 → 条件恒真，浏览器路径逐字节不变。
    if (decision && (!gate || gate.allowSpeak(mentions))) kick({ idle: false, thinkMs: decision.thinkMs, frame })
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
      // P4 迷糊层：静默窗（quietHours / 刚上线窗）里被点名仍可回，但像没睡醒——
      // 思考更久、回复更短、不拆段。gate 缺省/无 quietNow（浏览器）→ 不启用。
      const drowsy = humanize && !!(gate && typeof gate.quietNow === 'function' && gate.quietNow())
      const thinkMs = drowsy
        ? Math.min(job.thinkMs * HUMANIZE_DEFAULTS.drowsyThinkFactor, RHYTHM_DEFAULTS.totalDelayCapMs)
        : job.thinkMs
      await sleep(thinkMs) // 思考延迟（注入 sleep：假时钟可停可推）
      if (!started || epoch !== roomEpoch) return // 等待期间停/切房 → LLM 都不必发

      // P4：每轮抽一个目标字数（拟人分布），随 transcript 尾注注入；drowsy 压到 ≤8。
      const targetLen = humanize
        ? Math.min(sampleTargetLength(humanizeRng), drowsy ? HUMANIZE_DEFAULTS.drowsyMaxTarget : 30)
        : null
      let res
      try {
        res = await chatCompletion({
          provider,
          model: bot.model,
          temperature: bot.temperature,
          messages: humanize
            ? buildTranscriptMessages({
              system: systemPrompt,
              frames: buffer.all(),
              selfNick: nick,
              idle: job.idle,
              window: PROMPT_WINDOW,
              targetLen,
              drowsy,
            })
            : buildMessages({
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
        // Q7：两类都上报观测端口（fatal 布尔区分）——静默放弃正是 24/7 daemon 的
        // 「哑巴 bot」盲区。非 LlmError 异常（含畸形输入兜底）不发事件：kind/message
        // 契约只认 LlmError，不拼其 detail/响应体/请求配置（红线 B9/A3 不许 widening）。
        if (err instanceof LlmError) {
          const isFatal = err.kind === 'auth'
          onEvent?.('error', { kind: err.kind, message: redact(err.message), fatal: isFatal })
          if (isFatal) stop('TOKEN 失效', true)
        }
        return
      }
      // B7 双保险其一：在途期间切房/停机 → 响应作废（连打字延迟都不掷）
      if (!started || epoch !== roomEpoch) return

      // token 用量按「一次成功的 LLM 调用」记一次——沉默/空回复同样产生真实花费，
      // 不能因为没发消息就漏记（messages 才按实际发出的条数逐条累加）。
      session = {
        ...session,
        promptTokens: session.promptTokens + res.promptTokens,
        completionTokens: session.completionTokens + res.completionTokens,
      }

      let segments
      if (humanize) {
        // 沉默 → 整轮不发送、不记账、不掷 typing/afk（预算按“实际发出的消息”计）。
        // drowsy 时不拆段：迷糊的人不会连珠炮。
        const plan = planReply(res.text, { rng: humanizeRng, targetLen, allowSegments: !drowsy })
        if (plan.silent) {
          patch({ session: { ...session } })
          return
        }
        segments = plan.segments
      } else {
        const text = clampText(res.text) // B6：发送前必截（llm 只 trim 不截断）
        segments = text ? [text] : []
      }
      if (!segments.length) {
        patch({ session: { ...session } }) // B6：空回复不发，但 token 账照记
        return
      }

      const typing = rhythm.typingDelay(segments.join('').length)
      // 合计封顶 Math.min(think+typing, 15000)：第二段只补差值（drowsy 用加长后的 thinkMs）
      await sleep(Math.max(0, Math.min(typing, RHYTHM_DEFAULTS.totalDelayCapMs - thinkMs)))
      if (!started || epoch !== roomEpoch) return
      // rate 帧可能在 think/typing 期间到达：进入发送循环前就复查冷却，首段也不硬发。
      if (cooling) return
      // B7 双保险其二：触发帧所在房必须仍是当前房
      if (job.frame && job.frame.roomId !== connection.currentRoomId) return

      let afkRolled = false
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          // 段间拟人停顿（spec §10.2“间隔抽延迟”）：固定 8s minGap 管不到同一轮的连发，
          // 由 350–1200ms 的短停顿制造“想到一句发一句”的节奏。
          await sleep(between(humanizeRng, HUMANIZE_DEFAULTS.segmentGapMs))
          // 每段前复查：停机/切房/换房/被 rate 冷却——剩余段一律不发，绝不把旧房的话
          // 带进新房，也不在限速冷却中硬发。
          if (!started || epoch !== roomEpoch) return
          if (job.frame && job.frame.roomId !== connection.currentRoomId) return
          if (cooling) return
        }
        const text = segments[i]
        if (!text) continue
        if (!connection.send({ type: 'message', text, badge })) return // 非 open 静默放弃

        // —— 每段发送成功各自记账 ——
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
        // 小时计数/最小间隔逐条推进；AFK 骰整轮只掷一次（分段是一个社交动作）。
        rhythm.noteSpoken({ rollAfk: !afkRolled })
        afkRolled = true
        rateStreak = 0 // 成功发言打断 rate 连续计数（B4「连续」口径）
        cooling = false
        session = { ...session, messages: session.messages + 1 }
        hourCount = rhythm.status().hourCount
        patch({ rev, session: { ...session }, hourCount })
        pushStatus()
        // 自家消息 = 家族活动（终审 #7）：调度器对家族消息走 max 语义，不腰斩 idle 长窗
        // R12：sent:true 是全局小时闸的计数判别位——只在发送侧自报这里出现；
        // 观察路径不带此键。family 的调度语义不因 sent 增减而改变（sent 仅供计数）。
        // 分段时逐条发事件：全局小时闸按“消息条数”记账，不是按“LLM 轮次”。
        onEvent?.('activity', { roomId: connection.currentRoomId, family: true, sent: true })
      }
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
          onEvent?.('warn', { reason: 'SLOW DOWN' }) // Q7：限流三连降级停用，报因先于 stopped
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
    // R24（Task 3b）：每 bot 小时预算透传——配了有限 hourlyBudget 才浅覆盖 rhythm 的
    // hourlyCap；未配（快照里是 null——deck 的 pick 把 undefined 映射成 null，R17）
    // 连 params 键都不出现 → 缺省 30。Number.isFinite 判别天然分流 null 与 0
    // （0=合法语义「点名外一条不发」→ hourlyCap:0）。params 只改界限不改掷骰次数：
    // 构造期 rng 消耗位数（streakLimit 首掷）与预算有无无关。
    const rhythmOpts = { rng, now, chattiness: bot.chattiness }
    if (Number.isFinite(bot.hourlyBudget)) rhythmOpts.params = { hourlyCap: bot.hourlyBudget }
    rhythm = createRhythm(rhythmOpts)
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
    // Q9/§12 刹车：闲置发起属「非点名主动开口」，静默窗内直接静默——放在掷骰之前，
    // 不消耗 rng、不动 rhythm 状态。deck 的 onGlobalTick 已有同名前置判定，此处兜底
    // 直调 pokeIdle 的路径（含 preRolled：tick 与 poke 之间恰好跨入窗内时宁默不烧）。
    if (gate && !gate.allowSpeak(false)) return
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
