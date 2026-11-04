// Task 13（§8.1.1 配置桥）：浏览器 BOT DECK → daemon 手写 ESM 配置文件的**序列化器**。
// 纯字符串构造，零 IO、零网络、零浏览器全局——产物字节只在 BotDeck 的按钮里进本地 Blob。
//
// R6（禁跨边 import）：本文件不得 import packages/bot-daemon/**（那边用 node: 内建，jsdom
// 会炸；反向则把 Vue 拖进 Node）。与 daemon Cfg 的形状兼容由计划「共享 fixture」权威文本
// 在两侧各自断言钉死（tests/botExport.test.js ↔ packages/bot-daemon/tests/config.test.js）。
// 此处只作注释引用的目标形状：
//   { name, serverUrl, provider: { baseUrl, apiKey, model }, limits?, ownerNick?,
//     bots: [{ id, name, persona, room, chattiness?, temperature?, hourlyBudget?, rawPrompt? }] }
//
// R18(1) + R41（修正轮 1 裁定）：旋钮行（chattiness/temperature/hourlyBudget）当且仅当
// 值**与 core 缺省不同**时写出；同缺省值 → 整行省略，让 daemon 运行时继承 core 缺省。
// 为什么判据从「键不存在」改成「值 ≠ 缺省」：按钮的唯一数据源是 reactive deck，deck 里
// 每个 bot 都过了 core normalizeCfg（deck.js:496/499），chattiness/temperature 永远带值
// 在场——「键不存在」的输入活体造不出，按旧判据每次导出都会钉进 `chattiness: 50`，把
// 当日缺省冻进用户手写文件、日后 core 改默认对该用户永久失效（R16/R17 消灭的分叉类，
// 换个途径复活）。core 缺省从 kuoluosaigai-bot-core import（与 BotDeck.vue R18(2) 同源），
// 不抄字面量；hourlyBudget 的对照值是 RHYTHM_DEFAULTS.hourlyCap（30，rhythm.js:31）。
//   已知取舍（写进产物文件头）：用户**故意**把旋钮设成正好缺省值时该行也被省略 → 该 bot
//   改为跟随 core 未来默认。选择理由是两害相权：冻结会在 core 改值时静默分叉浏览器与
//   daemon 两个宿主（G2/A8 反面），跟随只是「用户没明确锁的东西跟着权威走」。
//   想锁定当前缺省 → 在文件里手写该行（validateConfig 会原样保留显式值）。
//   序列化器依旧不做任何回填（缺省对照 ≠ 回填：省略行不产生值）。
//
// A1：apiKey 一律写成 `process.env.KUO_LLM_KEY` 活表达式（§8.1 权威样例逐字一致），
// 任何输入里的明文 key 都不进输出——provider 序列化面根本不包含 apiKey 的值。
//
// 转义策略（单一且钉死）：所有字符串值走 JSON.stringify——JSON 双引号串是合法 JS 字面量，
// 反引号与 ${...} 在双引号内无插值语义，换行/引号/反斜杠转义为 \n \" \\，产物恒可解析。
// core 权威缺省（R41 对照值）——与 BotDeck.vue R18(2) 同一来源，本文件不得抄字面量。
import { DEFAULT_CHATTINESS, DEFAULT_TEMPERATURE, RHYTHM_DEFAULTS } from 'kuoluosaigai-bot-core'
//
// 已知取舍（daemon Cfg 只有一数 provider）：多个 provider 被不同 bot 引用时，取**首个被
// 引用者**（providers 数组序），provider.model 取首个引用它的 bot 的 model；未被引用的
// provider 整条不进导出物。多宿主分流属 P3 话题，不在 §8.1.1 范围。

// Q3 红线（daemon validateConfig 同款）：id 必填且稳定。浏览器自造 id（bot-N）天然合规；
// 缺失/非法（中文、大写、空格、超长）→ 净化，净化后为空 → 确定性哈希兜底（同输入同 slug，
// 重导出不会让 bot「换身份」）。
const BOT_ID_RE = /^[a-z0-9-]{1,32}$/

// §5 权威服务器地址——daemon 侧 DEFAULT_SERVER_URL 的浏览器镜像。R6 不许 import，
// 两侧各留一份由共享 fixture 测试钉值（fixture 的 serverUrl 就是这个串）。
const DEFAULT_SERVER_URL = 'wss://kuoluosaigai.com'

// A1 占位的 env 名——与 §8.1 样例、Task 4 fixture、deploy README 同一字符串。
const API_KEY_ENV_PLACEHOLDER = 'process.env.KUO_LLM_KEY'

/** 字符串值序列化：JSON.stringify 即上述转义策略的全部实现。 */
function q(v) {
  return JSON.stringify(String(v))
}

/**
 * R18(1)+R41 旋钮判定：值是有限数字**且与 core 缺省不同**才产出 `key: value` 片段；
 * 同缺省值 → null（整行省略，daemon 继承 core 缺省）。null/NaN/字符串一律视为未设。
 * 注意产物文本头注释不得出现「键名+冒号」形态，否则 tests/botExport.test.js 的
 * not.toMatch(/chattiness:/) 缺席断言会被注释误伤——措辞变更时保持该形状。
 */
function knob(key, v, coreDefault) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === coreDefault) return null
  return key + ': ' + String(v)
}

/** FNV-1a 32 位 + base36——纯算术无全局依赖，同输入恒同输出（稳定 id 的兜底源）。 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 把任意文本净化成 [a-z0-9-] 形态：小写、非法段折成单个 -、去首尾 -、截 32。 */
function cleanSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

/**
 * bot 的导出 id：合规原样、非法净化、空则名字/哈希兜底，并与同批已用 id 去重
 * （daemon 对重复 id 直接报错，导出器不得生产撞号文件）。
 */
function deriveBotId(bot, index, taken) {
  const rawId = typeof bot.id === 'string' ? bot.id : ''
  let slug = BOT_ID_RE.test(rawId) ? rawId : (cleanSlug(rawId) || cleanSlug(typeof bot.name === 'string' ? bot.name : ''))
  if (!slug) slug = 'bot-' + fnv1a(rawId + '\u0001' + String(bot.name ?? '') + '\u0001' + String(bot.persona ?? ''))
  slug = slug.slice(0, 32)
  if (taken.has(slug)) slug = (slug + '-' + (index + 1)).slice(0, 32) // 兜底去重；-N 仍合字符集
  taken.add(slug)
  return slug
}

/** 单条 bot → fixture 同款的行内对象文本（`    { ... },`）。可选字段缺席即不写行。 */
function botLine(bot, index, taken) {
  const parts = [
    'id: ' + q(deriveBotId(bot, index, taken)),
    'name: ' + q(bot.name ?? ''),
    'persona: ' + q(bot.persona ?? ''),
    'room: ' + q(bot.roomId ?? bot.room ?? ''), // 浏览器侧叫 roomId，daemon Cfg 叫 room（形状翻译点）
  ]
  // R41：同 core 缺省值整行省略（活体 bot 都带回填值，键存在与否不携带用户意图，
  // 值对照才是「用户真设过」的可辩护判据）
  const chattiness = knob('chattiness', bot.chattiness, DEFAULT_CHATTINESS)
  if (chattiness !== null) parts.push(chattiness)
  const temperature = knob('temperature', bot.temperature, DEFAULT_TEMPERATURE)
  if (temperature !== null) parts.push(temperature)
  const hourlyBudget = knob('hourlyBudget', bot.hourlyBudget, RHYTHM_DEFAULTS.hourlyCap) // R24「配了才存在」+ 30=缺省同值省略
  if (hourlyBudget !== null) parts.push(hourlyBudget)
  const rawPrompt = typeof bot.rawPrompt === 'string' && bot.rawPrompt !== '' ? bot.rawPrompt : null
  if (rawPrompt !== null) parts.push('rawPrompt: ' + q(rawPrompt))
  return '    { ' + parts.join(', ') + ' },'
}

/** 被 bot 引用的首个 provider（providers 序）；无人引用则退回第一个。 */
function pickProvider(providers, bots) {
  const refs = new Set()
  for (const b of bots) {
    if (b && typeof b.providerId === 'string' && b.providerId) refs.add(b.providerId)
  }
  const used = providers.find((p) => p && refs.has(p.id)) || providers[0] || null
  const owner = used && typeof used.id === 'string' ? used.id : null
  // model 在浏览器挂 bot、在 daemon 挂 provider——取首个引用该 provider 且有非空 model 的 bot
  const modelBot = bots.find((b) => b && (owner === null ? true : b.providerId === owner) && typeof b.model === 'string' && b.model !== '')
  return {
    baseUrl: used ? String(used.baseUrl ?? '') : '',
    model: modelBot ? String(modelBot.model) : '',
  }
}

/**
 * 生成可直接 `--config` 载入的 ESM 配置文件文本（合法纯数据 default export）。
 * @param {{
 *   providers?: Array<{ id: string, baseUrl?: string, apiKey?: string }>,
 *   bots?: Array<{ id?: string, name: string, persona: string, roomId?: string, providerId?: string,
 *                   model?: string, chattiness?: number, temperature?: number,
 *                   hourlyBudget?: number, rawPrompt?: string }>,
 *   deviceName?: string,
 *   serverUrl?: string,
 * }} input bots/providers 传 store 的响应式数组或裸对象皆可；缺省字段按「未设」处理（R18(1)）。
 * @returns {string} 配置文件全文
 */
export function buildConfigFile({ providers = [], bots = [], deviceName = 'browser-deck', serverUrl = DEFAULT_SERVER_URL } = {}) {
  const botList = Array.isArray(bots) ? bots : []
  const provList = Array.isArray(providers) ? providers : []
  const provider = pickProvider(provList, botList)
  const taken = new Set()
  const lines = [
    '// saigai-bot.config.js —— 由浏览器 BOT DECK 本地导出生成（§8.1.1，全程无网络）。',
    '// apiKey 只写 ' + API_KEY_ENV_PLACEHOLDER + ' 占位，明文 key 留在环境变量里，别写进本文件（A1）。',
    '// 拟人参数（chattiness/temperature/hourlyBudget）省略该行 = 跟随 core 默认；写出显式值 = 锁定当前值（R41）。',
    '// 与缺省同值的旋钮被省略是有意取舍——冻结会让浏览器与 daemon 在 core 改默认后静默分叉；想锁定就手写该行。',
    'export default {',
    '  name: ' + q(deviceName || 'browser-deck') + ',',
    '  serverUrl: ' + q(serverUrl || DEFAULT_SERVER_URL) + ',',
    '  provider: { baseUrl: ' + q(provider.baseUrl) + ', apiKey: ' + API_KEY_ENV_PLACEHOLDER + ', model: ' + q(provider.model) + ' },',
    '  bots: [',
  ]
  for (let i = 0; i < botList.length; i++) {
    lines.push(botLine(botList[i] || {}, i, taken))
  }
  lines.push('  ],', '}', '')
  return lines.join('\n')
}
