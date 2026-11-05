// Task 7：daemon 宿主组装——配置↔deck 调和、启停与快照（P1 daemon 的装配点）。
//
// 这里是 daemon 侧**唯一**碰 createDeck 的地方：Task 8 的 watcher 只调 converge(nextCfg)，
// Task 9 的 CLI 只调 boot/shutdown，Task 10 的 status 只读 snapshot()，Task 11 的 logger
// 只被注入。接口准确性优先于聪明：下面的每个映射都有 brief/裁定的出处，改动前先读注释。
//
// —— 关键顺序与一体化（Task 2 遗留 finding 的落点）——
// deck 构造时 createGate 就钉死 startedAt = now()，startupQuietMs 的「刚上线静默窗」
// 只在**构造与启动同一动作**中有意义。所以 deck 不在 createDaemonHost 里提前建，
// 而在 boot() 内建，随后全部 startBot 在同一次 boot() 调用里 await 完成（null lease 的
// acquire 同步兑现，中间没有外部事件循环回合）。deck 也没有 startedAt 显式注入口——
// 「早构造晚启动」这条路根本不该走，走了就是静默窗失效。
//
// —— 调和顺序（钉死于 brief Step 3）——
// 先 deck.load() 再动任何东西：state.js 的孤儿收拢以「上一次落盘的文档」为基准，
// 若先 addBot/persist 再 load，盘上旧 bot 会被当成消失的 id 错打孤儿。load 后读
// readOrphans()（getItem 供入层已剥 orphans，孤儿只此一个读面），再清 ghost、
// 建/对齐 bot、复用孤儿 nick、逐个 startBot。
//
// —— 孤儿账目相加（Task 5 审查裁定）——
// core 没有 lifetime 注入口（applySessionDelta 只懒建），被删再重建的 bot 账目从零
// 起记——孤儿旧段与新段是**不相交的两段，snapshot 里求和**，不是二选一；不私改
// deck.lifetime。
//
// —— A1/A3 key 红线在本文件的落点——
// apiKey 只从 ensureProvider 进 deck（cfg.provider.apiKey ?? process.env.KUO_LLM_KEY——
// env 求值本归配置文件，兜底只为未校验直连路径）；state.js 落盘前剥 key；snapshot()
// 白名单字段、逐键手工拼——providers 列表整个不进快照；日志只走 safeLog，从不带 key。
//
// —— R19 两条日志归本任务（state.js 不持有 logger）——
// ①boot/converge 复用孤儿身份 → info（含 id 与 nick）；②deck 移除 bot → **warn 级
// ORPHAN**（含 id 与「身份与账目保留在 state、写回同名 id 即复用」）。缺②Q2 的保护
// 只剩一半：数据留下了但操作者看不见。
//
// —— sink 免疫（Task 1 审查遗留）——
// deck 的 deps.onEvent 在 runner 的 catch 内被调；logger（Task 11）磁盘满/EPIPE 抛错
// 会在 24/7 进程里升级成 unhandled rejection。所有 logger 调用一律过 safeLog 吞抛——
// logger 死了没人能记下它死了，但 daemon 不能陪葬。
//
// —— limits/serverUrl 变化：defer + 显式告知（brief 括注 + 裁定 R27①）——
// gate/hourAccountor 与 wsUrl 都在 deck 构造期冻进闭包，core 没有任何热更新 API；
// 「重算闸」在当前 core 上不可实现，而重启 deck = 全体掉线，直接违反 A4 的
// 「不重启 bot」。取舍：bot 面一律不动（A4 保住），limitsChanged/serverUrlChanged
// 如实进 Report、restartRequired 标记 + warn 级日志告知「daemon 重启后生效」
// （配置不丢：重启 boot 自然带上）；且 meta.restartRequired 是**粘滞位**（R26 完成
// 条件），只由进程重启清除——后续无变化的 converge 不许把它洗掉。
// provider 的同类局限分两半（R27②）：model 实为 bot 字段，providerChanged 且 model
// 有变时扇出 updateBot 到**全部存活 bot**（changed ∪ unchanged；updateBot 不碰 runner，
// A4 不破）；apiKey/baseUrl 与改过的人格参数是 runner 启动期快照，用 needsBotRestart
// 标注「下次 bot 重启生效」。若裁定要求闸热生效，需 core 开 gate 重建口——报告待裁。
// 热移除先 deck.persist() 再 stop/remove（R27 捆绑①）：孤儿折叠取**上次落盘**基准，
// deck 的 lifetime 有 10s 节流——不先冲刷，窗口内的 token 账会在 removeBot 删
// store.lifetime[id] 的那一刻凭空蒸发，直接吃 Q2「state 拥有账目」的承诺。

import path from 'node:path'
import { createDeck, createNullLease } from 'kuoluosaigai-bot-core'
import { diffConfigs, changedBotFields } from './converge.js'
import { createRuntimeStore as createRuntimeStoreImpl, RUNTIME_FILE_NAME } from './runtime.js'
import { createDeviceIdentity as createDeviceIdentityImpl } from './device.js'
import { createRelayClient as createRelayClientImpl } from './relay-client.js'
import { createCommandHandler as createCommandHandlerImpl, buildDevState } from './commands.js'

/**
 * R20：把 runtime.json 的房间覆盖应用到 deck。
 * - baseRoom 与当前配置房不一致 → 配置改过房，清覆盖（配置赢）；
 * - 一致 → 切到覆盖房（启动/热重载都可重复调用，已在目标房则不动）。
 * @returns {{ applied: string[], cleared: string[] }}
 */
export function applyRoomOverrides({ deck, runtime, bots }) {
  const applied = []
  const cleared = []
  const errors = []
  if (!deck || !runtime) return { applied, cleared, errors }
  for (const bot of bots || []) {
    let o
    try {
      o = runtime.getRoomOverride(bot.id)
    } catch (e) {
      errors.push(bot.id) // runtime 读失败：保留配置房，绝不因此中断 boot/converge
      continue
    }
    if (!o) continue
    if (o.baseRoom !== bot.room) {
      try {
        runtime.clearRoomOverride(bot.id)
        cleared.push(bot.id)
      } catch (e) {
        errors.push(bot.id)
      }
      continue
    }
    const item = deck.bots.find((b) => b.id === bot.id)
    if (!item) continue
    const effective = item.rt.roomId || item.roomId
    if (effective === o.room) continue
    try {
      deck.switchBotRoom(bot.id, o.room)
      applied.push(bot.id)
    } catch (e) {
      errors.push(bot.id)
    }
  }
  return { applied, cleared, errors }
}

// provider 的 deck 侧稳定 id：显式 id 寻址（Q3 同款原则），重启 load 回来的是同一条目，
// ensureProvider 走 update 不重复 add。
export const PROVIDER_ID = 'daemon'
const PROVIDER_NAME = 'daemon'

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== ''
}

function resolveApiKey(provider) {
  const direct = provider ? provider.apiKey : undefined
  if (isNonEmptyString(direct)) return direct
  const env = process.env.KUO_LLM_KEY
  return isNonEmptyString(env) ? env : ''
}

// cfg.limits → deck schedule：只映射存在且合法的键（validateConfig 已保证形状）。
function scheduleFromLimits(limits) {
  const schedule = {}
  if (limits.quietHours) schedule.quietHours = { from: limits.quietHours.from, to: limits.quietHours.to }
  if (Number.isFinite(limits.startupQuietMs)) schedule.startupQuietMs = limits.startupQuietMs
  if (Number.isFinite(limits.globalHourlyMessages)) schedule.globalHourlyMessages = limits.globalHourlyMessages
  return schedule
}

function findBotCfg(c, id) {
  const list = c && Array.isArray(c.bots) ? c.bots : []
  return list.find((b) => b.id === id) || null
}

// cfg bot → deck addBot 载荷：room→roomId（Q1 配置字段名 vs core 内部名），显式 id（Q3），
// hourlyBudget/rawPrompt「未配=不设键」（R24/R17：null 会被 normalizeCfg 当缺省、undefined
// 键会被 pick 洗成 null，两头都要避开）。
function deckBotCfg(bot, model) {
  const cfg = {
    id: bot.id,
    name: bot.name,
    persona: bot.persona,
    chattiness: bot.chattiness,
    temperature: bot.temperature,
    roomId: bot.room,
    providerId: PROVIDER_ID,
  }
  if (isNonEmptyString(model)) cfg.model = model
  if (bot.rawPrompt !== undefined) cfg.rawPrompt = bot.rawPrompt
  if (bot.hourlyBudget !== undefined) cfg.hourlyBudget = bot.hourlyBudget
  return cfg
}

/**
 * 创建 daemon 宿主。
 * @param {{
 *   cfg: object,                       // validateConfig 产物（ok=true 的 cfg）
 *   store: { getItem: Function, setItem: Function, readOrphans: Function, path: string }, // Task 5 返回值，按 R4 直连 storage
 *   logger: { info: Function, warn: Function, error: Function }, // Task 11 造真身；全部调用过 safeLog
 *   now?: () => number,
 *   WebSocketImpl?: Function,          // 缺省 → core/浏览器全局（裁定 D1）
 *   sleep?: Function,
 *   createRunner?: Function,           // 测试接缝：brief Step 1 要求注入假 runner
 *                                      // （宿主签名里没有它就没法「真 WS 不连」——透传给 deck deps）
 * }} options
 * @returns {{ boot: () => Promise<void>, converge: (nextCfg: object) => Promise<object>, snapshot: () => object, shutdown: () => void }}
 */
export function createDaemonHost({
  cfg,
  store,
  logger,
  now = Date.now,
  WebSocketImpl,
  sleep,
  createRunner,
  createRuntime = createRuntimeStoreImpl, // 测试接缝
  createIdentity = createDeviceIdentityImpl,
  createLink = createRelayClientImpl,
  createHandler = createCommandHandlerImpl,
  enableLink = true,
  statePushMs = 15000,
} = {}) {
  if (!cfg || !store) throw new TypeError('createDaemonHost: cfg 与 store 必填')
  const log = logger || { info() {}, warn() {}, error() {} }

  let current = cfg
  let deck = null
  let runtime = null
  let identity = null
  let link = null
  let commandHandler = null
  let statePushTimer = null
  let bootedAt = null
  // R27 捆绑②（R26「不可能看漏」的完成条件）：需要**进程重启**才能兑现的变化是粘滞位，
  // converge 置位、snapshot 常驻上报；只有换新 host（进程重启语义）才回 false。
  let pendingRestart = false
  // R30（Q4/裁定 R29 补正）：P1 的 deviceId **恒为 null**——os.hostname() 是冒名身份：
  // 它既不是设备令牌（Q4 要求首启在数据目录铸造本地令牌、§14 建议 SHA-256 前 8 位，
  // 归 P3），又会在 status 里让操作者误信它就是 deviceId，还会把机器标识带进 P3 的
  // dev-state 帧流出本机。键位保留（R29：Task 10 原样渲染 meta、P3 需要字段在场），
  // 人类可读标签本就有 meta.name（配置 name）。
  let deviceId = null // P3b：boot 时由 device.json 令牌派生；boot 前 null

  // —— 日志：一切经 safeLog ——
  function safeLog(level, msg, fields) {
    try {
      const fn = log[level]
      if (typeof fn === 'function') fn.call(log, msg, fields)
    } catch (e) {
      /* sink 免疫：见文件头。抛错被吞是刻意的——日志器死了也不许带走 daemon。 */
    }
  }

  // Q7 观测端口（Task 1 的意义所在）：deck 的 error/warn 转发给 logger。
  // 载荷形状两种：runner 级 = {botId,...}；deck 级配置告警**省略 botId 键**
  // （审查轮 1 #1 契约）——消费方按 'botId' in payload 区分，本汇原样透传不补键。
  function emitToLogger(type, payload) {
    safeLog(type === 'error' ? 'error' : 'warn', 'bot-core ' + type, payload)
  }

  function orphanWarn(id, where) {
    // R19②：warn 级 ORPHAN。boot 清场与 converge 删除同规格——误删配置的保护
    // 不能只在热重载路径上可见（配置在 daemon 停机期间被删同样要留痕）。
    safeLog('warn', 'ORPHAN: bot ' + id + ' 已移出 deck（' + where + '）。身份与账目已保留在 state，' + '在配置里重新写回同名 id 即复用。', { botId: id })
  }

  function ensureProvider(c) {
    const provider = c.provider || {}
    const apiKey = resolveApiKey(provider)
    const existing = deck.providers.find((p) => p.id === PROVIDER_ID)
    if (existing) deck.updateProvider(PROVIDER_ID, { name: PROVIDER_NAME, baseUrl: provider.baseUrl, apiKey })
    else deck.addProvider({ id: PROVIDER_ID, name: PROVIDER_NAME, baseUrl: provider.baseUrl, apiKey })
  }

  function reuseOrphanNick(orphans, id) {
    const o = orphans[id]
    if (!o || !isNonEmptyString(o.nick)) return
    const item = deck.bots.find((b) => b.id === id)
    if (!item || isNonEmptyString(item.nick)) return // 身份已在场（state 回灌或服务器重发），不覆盖
    deck.updateBot(id, { nick: o.nick })
    // R19①：复用孤儿身份要出声（boot 与 converge 同规格）
    safeLog('info', '复用孤儿身份：bot ' + id + ' 沿用 state 中的昵称 ' + o.nick + '（身份跨重启延续）', { botId: id, nick: o.nick })
  }

  function startFailNote(id, res) {
    const why = res && res.error ? res.error : '未知错误'
    safeLog('error', 'bot ' + id + ' 未能进入 deck（' + why + '），本条不启动', { botId: id, reason: why })
  }

  function buildDeck() {
    const opts = {
      storage: store, // R4：state.js 返回值**整个**就是 storage 端口
      lease: createNullLease(),
      reactiveImpl: (o) => o,
      getOwnerNick: () => (isNonEmptyString(current.ownerNick) ? current.ownerNick : null), // Q11，活引用：converge 后即新值
      wsUrl: current.serverUrl,
      now,
      deps: { WebSocketImpl, sleep, onEvent: emitToLogger, createRunner },
    }
    // Step 3 钉死：limits 未配置就**不传** schedule——不是传空对象（传了就会建 gate，
    // Task 2 的「缺省零变化」承诺要在 daemon 侧也成立）。
    if (current.limits) opts.schedule = scheduleFromLimits(current.limits)
    return createDeck(opts)
  }

  function pushState() {
    if (!link || !deck || !link.paired()) return false
    const provider = current.provider || {}
    return link.pushState(buildDevState({
      snapshot: snapshot(),
      provider: { ...provider, apiKey: resolveApiKey(provider) },
      configBots: current.bots, // 非敏感定义字段（persona/话痨度…）；apiKey 不在配置 bot 里
    }))
  }

  async function pair() {
    if (!link) throw new Error('device link unavailable')
    return link.requestPair()
  }

  async function revokeAll() {
    if (!link || !identity) throw new Error('device link unavailable')
    const oldToken = identity.token()
    const next = identity.rotate() // 先落盘新令牌；失败会自行回滚
    try {
      link.setToken(next.token)
      return await link.rotate(next.token)
    } catch (e) {
      // 只有服务端**明确拒绝**（新令牌未落盘）才回滚。超时/断线时服务端可能已经提交，
      // 把旧令牌写回去会撞墓碑、让链路永久 401；此时保留新令牌，让重连去收敛。
      if (e && e.code === 'rejected') {
        identity.setToken(oldToken)
        link.setToken(oldToken)
      }
      throw e
    }
  }

  async function boot() {
    if (deck) throw new Error('daemon host：boot() 每生命周期只调一次（重启进程请重建 host）')
    bootedAt = now()
    // P3b：设备身份与 state.json 同目录；store 非文件态（测试替身）时不铸造。
    identity = typeof store.path === 'string' ? createIdentity({ dir: path.dirname(store.path) }) : null
    deviceId = identity ? identity.deviceId() : null
    // 一体化：deck 在此刻才构造（startedAt 锚点），启动在紧随其后的同一动作序列里。
    deck = buildDeck()
    deck.load() // brief 顺序：先 load 再调和（构造期 loadInto 已读盘，本调用是显式确认，幂等）
    // R20：runtime.json 与 state.json 同目录（store.path 的文件态适配器才有 path）。
    runtime = typeof store.path === 'string'
      ? createRuntime({ file: path.join(path.dirname(store.path), RUNTIME_FILE_NAME) })
      : null
    const orphans = store.readOrphans() // 必须在任何 persist 之前读：调和写盘会重算孤儿

    ensureProvider(current)

    // 清 ghost：盘里有、配置里没有 → 移出 deck（removeBot 内部 stop + persist，
    // state.js 据此把 {nick, lifetime} 收拢进 orphans——Q2 不误删身份）。
    const wanted = new Set(current.bots.map((b) => b.id))
    for (const item of deck.bots.slice()) {
      if (wanted.has(item.id)) continue
      deck.persist() // 与 converge 删除同款写序：先冲刷在账的 lifetime，再 stop/remove
      deck.stopBot(item.id)
      deck.removeBot(item.id)
      orphanWarn(item.id, 'boot 调和')
    }

    const model = current.provider ? current.provider.model : ''
    const startable = []
    for (const bot of current.bots) {
      const existing = deck.bots.find((b) => b.id === bot.id)
      if (existing) {
        // state 回灌的是 {id, nick} 骨架（其余字段是 normalizeCfg 缺省）——用配置全量对齐。
        // patch 与 addBot 同形但永不含 nick：身份归 state/服务器，配置越权写 nick
        // 会覆盖复用在即的孤儿身份（deck.updateBot 自身也跳过 patch.id）。
        deck.updateBot(bot.id, deckBotCfg(bot, model))
        startable.push(bot.id)
      } else {
        const res = deck.addBot(deckBotCfg(bot, model))
        if (!res || res.error) {
          startFailNote(bot.id, res) // MAX_BOTS 兜底：announce 后跳过，不启动不占位
          continue
        }
        startable.push(bot.id)
        reuseOrphanNick(orphans, bot.id)
      }
    }

    // R20：启动前应用手机切过的房；配置房变过的覆盖在此清除并留痕。
    const roomsApplied = applyRoomOverrides({ deck, runtime, bots: current.bots })
    if (roomsApplied.applied.length) {
      safeLog('info', 'R20 房间覆盖：已恢复 ' + roomsApplied.applied.join(', ') + ' 的运行时房间', { bots: roomsApplied.applied })
    }
    if (roomsApplied.cleared.length) {
      safeLog('warn', 'R20 房间覆盖：配置房已变更，清除旧覆盖 ' + roomsApplied.cleared.join(', '), { bots: roomsApplied.cleared })
    }
    if (roomsApplied.errors.length) {
      safeLog('warn', 'R20 房间覆盖：读取/写入失败，按配置房继续 ' + roomsApplied.errors.join(', '), { bots: roomsApplied.errors })
    }

    // 逐个启动——与 deck 构造同一动作序列（见文件头「一体化」）。
    for (const id of startable) {
      await deck.startBot(id)
    }

    // P3b：设备通道客户端。enableLink=false 是主机单测接缝；生产 CLI 不传（默认开）。
    if (enableLink && identity) {
      commandHandler = createHandler({ deck, runtime, getConfig: () => current })
      link = createLink({
        url: current.serverUrl,
        token: identity.token(),
        name: current.name,
        WebSocketImpl,
        onCommand: (frame) => commandHandler.handle(frame),
        onStatus: () => {}, // 状态推送只走 onPaired（pair-claim 与重连两条路都会触发）
        onPaired: () => pushState(),
        logger: {
          info: (m) => safeLog('info', m),
          warn: (m) => safeLog('warn', m),
          error: (m) => safeLog('error', m),
        },
      })
      link.start()
      statePushTimer = setInterval(() => {
        try {
          pushState()
        } catch (e) {
          safeLog('warn', 'dev-state 周期推送失败（snapshot 或序列化异常），下一拍重试')
        }
      }, statePushMs)
      if (typeof statePushTimer.unref === 'function') statePushTimer.unref()
    }
  }

  async function converge(nextCfg) {
    if (!deck) throw new Error('daemon host：converge() 必须在 boot() 之后')
    const diff = diffConfigs(current, nextCfg)
    const prevProv = current.provider || {}
    const nextProv = nextCfg.provider || {}
    const modelChanged = diff.providerChanged && prevProv.model !== nextProv.model
    // 扇出值守卫（审查轮 2 #1，恢复基础版就有、R27 改造时被我弄丢的保护）：经
    // validateConfig 的 cfg 保证 model 非空（config.js:179-180），但「宿主不消毒」的
    // 直连路径可能给 ''/缺省——deck.updateBot 对 'model' in patch 就写（deck.js:276-281），
    // undefined 会毒死全部存活 bot 的下次启动（runner 配置缺失：model）。空值 → 不扇出，
    // 存活 bot 保留原 model（与 deckBotCfg 对 added bot 的同一守卫对称）。
    const modelFanout = modelChanged && isNonEmptyString(nextProv.model)

    // removed 先落地：腾 MAX_BOTS 名额，且后续 add/changed 的 persist 不会把已删 bot
    // 的孤儿收拢顺序搞乱。写序（R27 捆绑①）：persist 冲刷先于 stop/remove——deck 对
    // lifetime 有 10s 节流（trailing），而 removeBot 先删 store.lifetime[id] 再 persist，
    // 不先冲刷的话节流窗内的 token 账连孤儿都进不去，凭空蒸发（Q2 的账目半边）。
    for (const id of diff.removed) {
      deck.persist()
      deck.stopBot(id) // 幂等：不在 running 也安全（stopBotInternal）
      deck.removeBot(id)
      orphanWarn(id, '热重载')
    }

    const orphans = store.readOrphans()

    // provider 即时进 deck（updateProvider 带新 apiKey/baseUrl）；model 是 **bot** 字段
    // （core BOT_CFG_KEYS），R27② 扇出到全部存活 bot——updateBot 不碰 runner，A4 不破。
    // 在场 runner 仍是启动期快照，新值随各自下一次启动兑现：needsBotRestart 如实标注，
    // 不装「已生效」（R14 教训）。
    if (diff.providerChanged) ensureProvider(nextCfg)
    if (modelFanout) {
      for (const item of deck.bots.slice()) {
        deck.updateBot(item.id, { model: nextProv.model })
      }
    }

    for (const id of diff.added) {
      const bot = findBotCfg(nextCfg, id)
      if (!bot) continue
      const res = deck.addBot(deckBotCfg(bot, nextProv.model))
      if (!res || res.error) {
        startFailNote(id, res)
        continue
      }
      reuseOrphanNick(orphans, id)
      await deck.startBot(id)
    }

    for (const id of diff.changed) {
      const prevBot = findBotCfg(current, id)
      const nextBot = findBotCfg(nextCfg, id)
      if (!prevBot || !nextBot) continue
      // A4：改名/改人格一律 updateBot，绝不 stop/start。room 是唯一例外通道——
      // deck 备有 switchBotRoom（同连接切房），不算掉线。
      if (prevBot.room !== nextBot.room) {
        // R20：配置改了房 → 配置赢，旧运行时覆盖作废，避免下次重启把配置房抢回去。
        if (runtime) runtime.clearRoomOverride(id)
        deck.switchBotRoom(id, nextBot.room)
      }
      const patch = {}
      for (const k of changedBotFields(prevBot, nextBot)) {
        if (k === 'room') continue // 已由 switchBotRoom 处理
        patch[k] = nextBot[k] // undefined = 取消配置（hourlyBudget/rawPrompt 的未配语义）
      }
      // model 不在这里补——上面已对全部存活 bot 扇出（R27②），changed 桶同样是幸存者
      if (Object.keys(patch).length > 0) deck.updateBot(id, patch)
    }

    // R20：新加入/改房后的 bot 应用仍然有效的覆盖（改房的已在上面清掉）。
    const roomsNext = applyRoomOverrides({ deck, runtime, bots: nextCfg.bots })
    if (roomsNext.errors.length) {
      safeLog('warn', 'R20 房间覆盖：热重载时读写失败，按配置房继续 ' + roomsNext.errors.join(', '), { bots: roomsNext.errors })
    }

    const report = {
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      unchanged: diff.unchanged,
      limitsChanged: diff.limitsChanged,
      serverUrlChanged: diff.serverUrlChanged,
      providerChanged: diff.providerChanged,
      // restartRequired：闸（gate/hourAccountor）与 wsUrl 都在 deck 构造期钉死，
      // core 无热更新口——limits/serverUrl 变更本进程内只能「如实告知、重启兑现」
      // （R27①：两者同类，要的是进程重启，不是 bot 重启；见文件头裁量）。
      restartRequired: diff.limitsChanged || diff.serverUrlChanged,
      // needsBotRestart：apiKey/baseUrl 与改过的人格参数是 runner 启动期快照，随下一次
      // 逐 bot 重启兑现（model 已按 R27② 扇出进全部存活 bot 的 deck 配置）；连接不动（A4）。
      needsBotRestart: diff.providerChanged || diff.changed.length > 0,
    }
    if (report.restartRequired) pendingRestart = true // 粘滞位：只由进程重启清除
    // 独立播报（审查轮 2 #2）：两条真相同等地位，else-if 链会在 combined converge
    // 里吞掉 provider 线——Report 双位在场却只有一条日志，R27② 的诚实只做半截。
    if (diff.limitsChanged || diff.serverUrlChanged) {
      const what = diff.limitsChanged && diff.serverUrlChanged ? 'limits 与 serverUrl' : diff.limitsChanged ? 'limits' : 'serverUrl'
      safeLog('warn', what + ' 变化：闸与 wsUrl 在 deck 构造期冻结、core 无热重算口，本次热重载不触碰任何 bot 连接；将在 daemon 重启后生效（status 的 restartRequired 将保持置位）。', { limitsChanged: diff.limitsChanged, serverUrlChanged: diff.serverUrlChanged })
    }
    if (diff.providerChanged) {
      safeLog('warn', 'provider 配置变化：新 apiKey/baseUrl 已写入 deck provider' + (modelFanout ? '，新 model 已扇出至全部存活 bot（updateBot，不碰连接）' : '') + '；在场 runner 为启动期快照，将于各 bot 下次重启时生效（本次不主动断线）。', { providerChanged: true })
    }
    current = nextCfg
    return report
  }

  function snapshot() {
    const bots = []
    let globalHourCount = null
    if (deck) {
      globalHourCount = deck.globalHourCount // 属性不是方法（未配置=null，惰性结算由 core 管）
      const orphans = store.readOrphans()
      for (const b of deck.bots) {
        const live = deck.lifetime[b.id] || null
        const orphan = orphans[b.id] || null
        const old = orphan ? orphan.lifetime : null
        bots.push({
          id: b.id,
          name: b.name,
          // R20：报**有效房**（rt.roomId 优先于配置房），status 不许自证清白地撒谎
          room: b.rt.roomId || b.roomId || null,
          status: b.rt.status,
          nick: b.rt.nick || b.nick || null,
          hourCount: b.rt.hourCount,
          session: {
            promptTokens: b.rt.session.promptTokens,
            completionTokens: b.rt.session.completionTokens,
            messages: b.rt.session.messages,
          },
          // 孤儿旧段 + 复用后新段：两段不相交，**求和**（Task 5 审查裁定；
          // core 无 lifetime 注入口，不许私改 deck.lifetime）
          lifetime: {
            promptTokens: (live ? live.promptTokens || 0 : 0) + (old ? old.promptTokens || 0 : 0),
            completionTokens: (live ? live.completionTokens || 0 : 0) + (old ? old.completionTokens || 0 : 0),
          },
        })
      }
    }
    return {
      meta: {
        deviceId,
        name: current.name,
        uptimeMs: bootedAt === null ? 0 : Math.max(0, now() - bootedAt),
        globalHourCount,
        generatedAt: now(), // Task 10 的「数据为 N 秒前」口径原料
        // R27 捆绑②/R26：pending 进程重启的粘滞位——Task 10 的 status 唯一能看见它的面。
        // converge 置位后不会被后续 converge 洗掉，只随新 host（进程重启语义）归零。
        restartRequired: pendingRestart,
        // P3b：设备链路状态（配对 UI 与 status 消费；未接线时 false/null）
        paired: link ? link.paired() : false,
        linkStatus: link ? link.status() : null,
      },
      bots,
    }
  }

  function shutdown() {
    if (statePushTimer) {
      clearInterval(statePushTimer)
      statePushTimer = null
    }
    if (link) {
      link.stop()
      link = null
    }
    if (!deck) return
    deck.dispose() // 停全部 runner、释放租约、冲刷 lifetime（B12）；幂等
  }

  return { boot, converge, snapshot, shutdown, pair, revokeAll }
}
