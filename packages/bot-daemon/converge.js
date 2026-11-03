// Task 7：配置 diff —— diffConfigs 纯函数（热重载的动作集来源，先于接线测）。
//
// 契约（brief + 裁定 R27 钉死）：按 id 寻址（Q3）；changed = 除 id 外任一字段变；
// 数组顺序变化不算变更（按 id 集合与字段比较，不是位置）。三个"整机级"比较位：
// - limitsChanged：闸配置变化单独成位，不牵连任何 bot 桶（"不重启 bot"——闸的
//   落地时机归宿主，见 host.js converge）；
// - serverUrlChanged（R27①）：wsUrl 在 deck 构造期冻进闭包，与 limits 同类——要的是
//   **进程重启**而非 bot 重启。初稿计划盲在只比 bots+limits，且 current=nextCfg 会让
//   该改动对之后每一次 diff 永久隐形、整条链没有一层能报出来；
// - providerChanged（R27②）：provider 深比较（键序无关）——其中 model 实为 **bot**
//   字段（core BOT_CFG_KEYS），宿主须扇出到全部存活 bot，见 host.js。
// bots: [] 与三个 bot 的差异如实报 removed 三项：这是"用户真想全停"的合法表达，
// 与"畸形读盘"（ConfigLoadError，Task 8 watcher 保留旧配置）的区分归异常分流，不归本函数。
//
// 本文件无 IO、无 deck、无 logger——纯数据进纯数据出，Task 8/9/10 都可以直接复用。

// bot 参与比较的字段（cfg 形状归 Task 4 validateConfig：除 id/name/persona/room/
// chattiness/temperature 恒在场外，hourlyBudget/rawPrompt 是"未配=键不存在"的可选字段，
// 缺省≠0（R24），所以「未配↔配置」的往返也必须算变更）。
const BOT_COMPARE_KEYS = ['name', 'persona', 'room', 'chattiness', 'temperature', 'hourlyBudget', 'rawPrompt']

function botsById(c) {
  const m = new Map()
  const list = c && Array.isArray(c.bots) ? c.bots : []
  for (const b of list) {
    if (b && typeof b.id === 'string') m.set(b.id, b)
  }
  return m
}

/**
 * 纯数据规范化（键序无关）：limits 深比较用。undefined 归一为 null——
 * 「没有 limits 键」与「limits: undefined」必须同判未配置。
 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k])
    return out
  }
  return v === undefined ? null : v
}

function limitsEqual(a, b) {
  const ca = canonical(a === undefined ? null : a)
  const cb = canonical(b === undefined ? null : b)
  return JSON.stringify(ca) === JSON.stringify(cb)
}

function botDiffers(prevBot, nextBot) {
  return changedBotFields(prevBot, nextBot).length > 0
}

/**
 * 列出实际变化的字段名（cfg 侧键名，room 保持 'room'——由宿主翻成 roomId /
 * switchBotRoom）。next 缺键而 prev 有 → 该键入选，值为 undefined=取消配置语义。
 * @param {object} prevBot
 * @param {object} nextBot
 * @returns {string[]}
 */
export function changedBotFields(prevBot, nextBot) {
  const keys = []
  for (const k of BOT_COMPARE_KEYS) {
    if (prevBot[k] !== nextBot[k]) keys.push(k)
  }
  return keys
}

function urlOf(c) {
  const v = c ? c.serverUrl : undefined
  return v === undefined || v === null ? null : v
}

function providerOf(c) {
  return c && c.provider ? c.provider : null
}

/**
 * 配置 diff（纯函数）。
 * @param {{ bots?: Array<{id:string}>, limits?: object, serverUrl?: string, provider?: object }|null} prev
 * @param {{ bots?: Array<{id:string}>, limits?: object, serverUrl?: string, provider?: object }|null} next
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: string[],
 *   limitsChanged: boolean, serverUrlChanged: boolean, providerChanged: boolean }}
 *   四数组装 **id**（按 id 寻址，Q3）；added/changed/unchanged 沿 next 顺序，removed 沿 prev 顺序。
 */
export function diffConfigs(prev, next) {
  const prevBots = botsById(prev)
  const nextBots = botsById(next)
  const added = []
  const changed = []
  const unchanged = []
  for (const [id, nb] of nextBots) {
    const pb = prevBots.get(id)
    if (!pb) added.push(id)
    else if (botDiffers(pb, nb)) changed.push(id)
    else unchanged.push(id)
  }
  const removed = []
  for (const id of prevBots.keys()) {
    if (!nextBots.has(id)) removed.push(id)
  }
  const limitsChanged = !limitsEqual(prev ? prev.limits : undefined, next ? next.limits : undefined)
  const serverUrlChanged = urlOf(prev) !== urlOf(next)
  const providerChanged =
    JSON.stringify(canonical(providerOf(prev))) !== JSON.stringify(canonical(providerOf(next)))
  return { added, removed, changed, unchanged, limitsChanged, serverUrlChanged, providerChanged }
}
