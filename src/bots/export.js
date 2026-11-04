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
// R18(1)（从 raw 生成，绝不从回填后的 cfg 生成）：本函数只做「输入里有就序列化，没有就
// 整行不写」——绝不向 chattiness/temperature/hourlyBudget 回填 DEFAULT_*。回填是
// validateConfig 在 daemon 运行时做的事；导出物一旦替用户写了 `chattiness: 50`，就把
// 「当时代码里的默认值」钉进手写的配置文件，日后 core 改默认对该用户永久失效（R16/R17
// 消灭过的分叉类）。判据 = 缺席：tests/botExport.test.js 用省略字段的输入断言文本里连
// 键名都不出现。
//   ⚠️ 活体路径说明：浏览器 store.bots 已过 core normalizeCfg（deck.js 的有意语义——
//   表单提交本就带显式 chattiness），从该来源导出时这些字段必然在场；R18(1) 约束的是
//   **本序列化器不得引入第二次回填**，packages/** 不在本任务改动面内。
//
// A1：apiKey 一律写成 `process.env.KUO_LLM_KEY` 活表达式（§8.1 权威样例逐字一致），
// 任何输入里的明文 key 都不进输出——provider 序列化面根本不包含 apiKey 的值。
//
// 转义策略（单一且钉死）：所有字符串值走 JSON.stringify——JSON 双引号串是合法 JS 字面量，
// 反引号与 ${...} 在双引号内无插值语义，换行/引号/反斜杠转义为 \n \" \\，产物恒可解析。
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

/** R18(1)：仅当值是有限数字才产出 `key: value` 片段；缺省/null/NaN/字符串一律视为未设。 */
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null
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
  const chattiness = finiteNum(bot.chattiness)
  if (chattiness !== null) parts.push('chattiness: ' + chattiness)
  const temperature = finiteNum(bot.temperature)
  if (temperature !== null) parts.push('temperature: ' + temperature)
  const hourlyBudget = finiteNum(bot.hourlyBudget) // R24 语义「配了才存在」：store 里未设 = 无键
  if (hourlyBudget !== null) parts.push('hourlyBudget: ' + hourlyBudget)
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
