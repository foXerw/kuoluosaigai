// Task 4：daemon 配置层——ESM 配置文件的加载（§8.1）与纯数据校验（validateConfig）。
//
// 本文件只用 node: 内建 + kuoluosaigai-bot-core（零新增运行时依赖，裁定 D1 不引 ws）。
// 与浏览器侧 Task 13「导出配置」按钮的兼容性靠**同一段权威 fixture 文本**在两侧各自断言
// 来钉（裁定 R6）：这里含 node:fs/node:url，jsdom 里 import 会炸，反向 import 又会把 Vue
// 拖进 Node——两侧禁止互相 import，形状漂移由 tests/config.test.js 的 R6 用例把守。
//
// —— 为什么 limits 必须在配置层就拦住（裁定 R9 的完整理由）——
// core 侧对静默窗的两类故障方向**相反**：
// - `quietHours` 端点畸形（'25:00'、非字符串）→ inQuietWindow fail-**closed**：全天静默
//   （schedule.js 设计钉死「宁显得没睡醒，不可烧穿额度」），deck 建 gate 时还会一次性
//   onEvent('warn') announce——这是可见的、省钱方向的故障。
// - `quietHours` 键**缺失或拼错**（少个 s 的 `quietHour`）→ createGate 里 `quietHours &&`
//   判空 → fail-**open**：永不静默 → 正是这道刹车要防的**通宵烧钱**。core 的 warn 是
//   兜底（给 bot-core 直接消费者），**不是**配置层的替身——R9/R12 分工：配置层拦字面量，
//   core 层兜误用。两种失败方向相反，所以校验器必须在门外把两者都接住：未知键一律拒、
//   端点一律过 core 的 parseClock（复用同一实现，绝不另写第二份时间正则——上一轮终审
//   抓到过两处巧合相等的 15000 悄悄漂移，这是本仓的常驻教训）。
//
// —— room 只校形状（裁定 R15）——
// 服务器私有房注册表是服务端 append-only 的 `server/data/rooms.log`，daemon 静态无从得知，
// 白名单会把一切合法私房判非法。故只做形状 `/^[a-z0-9]{6}$/`；房间**是否存在**归运行时
// （配错在 join 时拿 join-error，由 runner 分级处理、doctor（Task 9）实测兜底）。
//
// —— loadConfig 的失败分流（Task 8 热重载 watcher 的前提）——
// 「读不到/解析不了」（IO 或半写坏语法 → ConfigLoadError，kind 区分）与「解析成功但内容
// 为空/非法」（正常返回，交给 validateConfig 报字段错）必须是**类型化**的两种结局：
// watcher 对前者要保留上一份好配置继续跑（绝不停掉所有 bot），对后者才照常收敛。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { MAX_BOTS, parseClock, DEFAULT_CHATTINESS, DEFAULT_TEMPERATURE } from 'kuoluosaigai-bot-core'

// 再导出：MAX_BOTS 唯一来源是 core，daemon 各处（含测试）从这里取，不得抄字面量。
export { MAX_BOTS }

// §5 缺省服务器地址。这是 daemon 侧自有默认（core 不持有服务器 URL），不是"抄 core 常量"。
const DEFAULT_SERVER_URL = 'wss://kuoluosaigai.com'
const SERVER_URL_RE = /^wss?:\/\//
const HTTP_URL_RE = /^https?:\/\//
const BOT_ID_RE = /^[a-z0-9-]{1,32}$/ // Q3：id 必填且稳定，改名=变更、增删 id=增删
const ROOM_RE = /^[a-z0-9]{6}$/ // R15：仅形状


const TOP_KEYS = ['name', 'serverUrl', 'provider', 'limits', 'ownerNick', 'bots']
const PROVIDER_KEYS = ['baseUrl', 'apiKey', 'model']
const LIMITS_KEYS = ['globalHourlyMessages', 'quietHours', 'startupQuietMs']
const QUIET_HOURS_KEYS = ['from', 'to']
const BOT_KEYS = ['id', 'name', 'persona', 'room', 'chattiness', 'temperature', 'hourlyBudget', 'rawPrompt']

/**
 * loadConfig 的类型化失败。kind 二选一：
 * - 'unreadable'：ENOENT/EACCES/模块图缺失等——内核 IO/模块图级的读不到（判定面见下方 IO_ERROR_CODES）。
 * - 'unparsable'：语法坏（编辑器半写状态最常见落点），**求值期副作用抛也归这里**
 *   （文件在、模块出不来——loadConfig 实现如此分类，本注释旧版曾误称其归 'unreadable'，
 *   Task 4 审查 parked 的文档缺陷，由 Task 9 更正；行为未变，判读以实现为准）。
 * 调用方用 `instanceof ConfigLoadError` + `.kind` 分流，不要靠 message 猜。
 */
export class ConfigLoadError extends Error {
  constructor(kind, filePath, detail, cause) {
    super('config-' + kind + ': ' + filePath + ': ' + detail)
    this.name = 'ConfigLoadError'
    this.kind = kind
    this.path = filePath
    this.cause = cause
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function positiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function describeImpurity(v) {
  const t = typeof v
  if (t === 'function') return '函数'
  if (t === 'symbol') return 'symbol'
  if (t === 'bigint') return 'bigint'
  const ctor = v && v.constructor && v.constructor.name
  return '类实例' + (ctor ? ' ' + ctor : '')
}

/**
 * 递归纯数据扫描（§8.1 红线：配置文件即代码 → 必须纯数据 default export）。
 * 允许：string/number/boolean/null/undefined、纯对象、数组、Object.create(null)；
 * 拒绝：函数、symbol、bigint、类实例（原型不是 Object.prototype/null）、`__proto__` 自属键、
 * 循环引用。读 env（process.env.X）求值后只剩普通字符串/undefined，天然放行——这是钉死的合法写法。
 */
function scanImpurity(value, label, found, seen) {
  const t = typeof value
  if (value === null || t === 'undefined' || t === 'string' || t === 'number' || t === 'boolean') return
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    found.push(label + ': 必须是纯数据（发现' + describeImpurity(value) + '）')
    return
  }
  if (t !== 'object') return
  if (seen.has(value)) {
    found.push(label + ': 必须是纯数据（循环引用）')
    return
  }
  seen.add(value)
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    found.push(label + ': 必须是纯数据（发现' + describeImpurity(value) + '）')
    return
  }
  const isArray = Array.isArray(value)
  for (const key of Object.keys(value)) {
    if (key === '__proto__') {
      found.push(label + '.' + key + ': 必须是纯数据（__proto__ 自属键）')
      continue
    }
    scanImpurity(value[key], isArray ? label + '[' + key + ']' : label + '.' + key, found, seen)
  }
}

/**
 * 校验原始配置对象（loadConfig 的产物，或任何来源的 unknown）。
 * 不做 IO、不 import 配置文件——纯函数，`validate` 子命令（Task 9）可直接复用。
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], cfg: object | null }}
 *   errors 每条以字段路径开头（`bots[2].id: ...`），doctor 可直接逐行打印；
 *   ok=true 时 cfg 为归一化配置（缺省回填 serverUrl/chattiness/temperature），否则 null。
 *   注意：错误文案绝不内插 apiKey 等敏感值（A1/A3——key 不进日志）。
 */
export function validateConfig(raw) {
  // 第一道闸：纯数据扫描。不纯则短路——对带函数/实例的对象做形状推断没有意义，
  // 且形状错误会随净化后的求值噪声淹没「配置即 RCE 面」这条最要命的信号。
  const impure = []
  scanImpurity(raw, 'root', impure, new Set())
  if (impure.length > 0) {
    return { ok: false, errors: impure, cfg: null }
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: ['root: 配置必须是纯数据 default export 对象（发现' + (Array.isArray(raw) ? '数组' : typeof raw) + '）'],
      cfg: null,
    }
  }

  const errors = []
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) errors.push('root.' + key + ': 未知键（允许：' + TOP_KEYS.join('/') + '）')
  }

  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push('name: 必须是非空字符串（人类可读设备名）')
  }
  if ('ownerNick' in raw && typeof raw.ownerNick !== 'string') {
    errors.push('ownerNick: 提供时必须为字符串')
  }

  let serverUrl = DEFAULT_SERVER_URL
  if ('serverUrl' in raw) {
    if (typeof raw.serverUrl === 'string' && SERVER_URL_RE.test(raw.serverUrl)) {
      serverUrl = raw.serverUrl
    } else {
      errors.push('serverUrl: 必须是 ws:// 或 wss:// 开头的字符串（本地联调用 ws://localhost:8080）')
    }
  }

  const provider = {}
  if (!isPlainObject(raw.provider)) {
    errors.push('provider: 必须是对象（' + PROVIDER_KEYS.join('/') + '）')
  } else {
    for (const key of Object.keys(raw.provider)) {
      if (!PROVIDER_KEYS.includes(key)) errors.push('provider.' + key + ': 未知键（允许：' + PROVIDER_KEYS.join('/') + '）')
    }
    provider.baseUrl = raw.provider.baseUrl
    provider.apiKey = raw.provider.apiKey
    provider.model = raw.provider.model
    if (typeof raw.provider.baseUrl !== 'string' || !HTTP_URL_RE.test(raw.provider.baseUrl)) {
      errors.push('provider.baseUrl: 必须是 http:// 或 https:// 开头的字符串')
    }
    if (typeof raw.provider.model !== 'string' || raw.provider.model.trim() === '') {
      errors.push('provider.model: 必须是非空字符串')
    }
    if (typeof raw.provider.apiKey !== 'string' || raw.provider.apiKey === '') {
      // 文案不回显值：process.env.X 未设时值是 undefined，设了则是敏感串，两头都不能进日志。
      errors.push('provider.apiKey: 必须是非空字符串（可写 process.env.KUO_LLM_KEY——校验层不回显 key 值）')
    }
  }

  let limits = null
  if ('limits' in raw) {
    if (!isPlainObject(raw.limits)) {
      errors.push('limits: 必须是对象（' + LIMITS_KEYS.join('/') + '）')
    } else {
      limits = {}
      for (const key of Object.keys(raw.limits)) {
        if (!LIMITS_KEYS.includes(key)) {
          errors.push('limits.' + key + ': 未知键（允许：' + LIMITS_KEYS.join('/') + '）——刹车键拼错等于"永不静默"（R9：必须拒）')
        }
      }
      if ('globalHourlyMessages' in raw.limits) {
        if (positiveFinite(raw.limits.globalHourlyMessages)) {
          limits.globalHourlyMessages = raw.limits.globalHourlyMessages
        } else {
          errors.push('limits.globalHourlyMessages: 必须是正数（跨 bot 全局小时闸预算）')
        }
      }
      if ('startupQuietMs' in raw.limits) {
        if (positiveFinite(raw.limits.startupQuietMs)) {
          limits.startupQuietMs = raw.limits.startupQuietMs
        } else {
          errors.push('limits.startupQuietMs: 必须是正数（刚上线静默窗毫秒）')
        }
      }
      if ('quietHours' in raw.limits) {
        const q = raw.limits.quietHours
        if (!isPlainObject(q)) {
          errors.push('limits.quietHours: 必须是对象（from/to）')
        } else {
          for (const key of Object.keys(q)) {
            if (!QUIET_HOURS_KEYS.includes(key)) {
              errors.push('limits.quietHours.' + key + ': 未知键（允许：' + QUIET_HOURS_KEYS.join('/') + '）')
            }
          }
          // 两端都过 core 的 parseClock：缺失/畸形端点过不了——core 对畸形端点 fail-closed
          // （全天静默）、对缺失键 fail-open（永不静默），方向相反，所以两头都在这里拦（R9）。
          const qh = {}
          for (const end of QUIET_HOURS_KEYS) {
            if (parseClock(q[end]) === null) {
              errors.push('limits.quietHours.' + end + ': 必须是合法 "HH:MM" 墙钟串（经 core parseClock 校验）')
            } else {
              qh[end] = q[end]
            }
          }
          if (QUIET_HOURS_KEYS.every((end) => end in qh)) limits.quietHours = qh
        }
      }
    }
  }

  let bots = null
  if (!Array.isArray(raw.bots)) {
    errors.push('bots: 必须是数组（每项一个 bot）')
  } else {
    if (raw.bots.length > MAX_BOTS) {
      errors.push('bots: 超出 MAX_BOTS=' + MAX_BOTS + '（常量从 core 再导出，daemon 不得抄字面量）')
    }
    const seenIds = new Set()
    bots = []
    raw.bots.forEach((b, i) => {
      const at = 'bots[' + i + ']'
      if (!isPlainObject(b)) {
        errors.push(at + ': 必须是对象')
        return
      }
      for (const key of Object.keys(b)) {
        if (!BOT_KEYS.includes(key)) errors.push(at + '.' + key + ': 未知键（允许：' + BOT_KEYS.join('/') + '）')
      }
      if (typeof b.id !== 'string' || !BOT_ID_RE.test(b.id)) {
        errors.push(at + '.id: 必须匹配 /^[a-z0-9-]{1,32}$/（Q3：id 必填且稳定）')
      } else if (seenIds.has(b.id)) {
        errors.push(at + '.id: "' + b.id + '" 与更早条目重复（dup）')
      } else {
        seenIds.add(b.id)
      }
      if (typeof b.name !== 'string' || b.name.trim() === '') errors.push(at + '.name: 必须是非空字符串')
      if (typeof b.persona !== 'string' || b.persona.trim() === '') errors.push(at + '.persona: 必须是非空字符串')
      if (typeof b.room !== 'string' || !ROOM_RE.test(b.room)) {
        errors.push(at + '.room: 必须匹配 /^[a-z0-9]{6}$/（R15：仅形状校验；房间存在性归运行时 join-error 与 doctor 实测）')
      }
      // 可选数值字段：显式 undefined（如 process.env 未设）按未提供走缺省；给了就要合法。
      let chattiness = DEFAULT_CHATTINESS
      if ('chattiness' in b && b.chattiness !== undefined) {
        if (Number.isFinite(b.chattiness) && b.chattiness >= 0 && b.chattiness <= 100) {
          chattiness = b.chattiness
        } else {
          errors.push(at + '.chattiness: 必须是 0~100 的数字')
        }
      }
      let temperature = DEFAULT_TEMPERATURE
      if ('temperature' in b && b.temperature !== undefined) {
        if (Number.isFinite(b.temperature) && b.temperature >= 0) {
          temperature = b.temperature
        } else {
          errors.push(at + '.temperature: 必须是 ≥0 的有限数字')
        }
      }
      // hourlyBudget 已接线（裁定 R24，core Task 3b）：Task 7 交 addBot →
      // deck.normalizeCfg 保留 → runner 按存在与否传 createRhythm params.hourlyCap。
      // 语义：缺省不写=沿用 rhythm 默认 30；0=合法（点名外一条不发）；两者不可混写。
      let hourlyBudget
      if ('hourlyBudget' in b && b.hourlyBudget !== undefined) {
        if (Number.isFinite(b.hourlyBudget) && b.hourlyBudget >= 0) {
          hourlyBudget = b.hourlyBudget
        } else {
          errors.push(at + '.hourlyBudget: 必须是 ≥0 的有限数字')
        }
      }
      let rawPrompt
      if ('rawPrompt' in b && b.rawPrompt !== undefined) {
        if (typeof b.rawPrompt === 'string') {
          rawPrompt = b.rawPrompt
        } else {
          errors.push(at + '.rawPrompt: 提供时必须为字符串')
        }
      }
      const bot = { id: b.id, name: b.name, persona: b.persona, room: b.room, chattiness, temperature }
      if (hourlyBudget !== undefined) bot.hourlyBudget = hourlyBudget
      if (rawPrompt !== undefined) bot.rawPrompt = rawPrompt
      bots.push(bot)
    })
  }

  if (errors.length > 0) return { ok: false, errors, cfg: null }

  const cfg = { name: raw.name, serverUrl, provider, bots }
  if (limits !== null && Object.keys(limits).length > 0) cfg.limits = limits
  if (typeof raw.ownerNick === 'string') cfg.ownerNick = raw.ownerNick
  return { ok: true, errors, cfg }
}

/**
 * 加载 ESM 配置文件（§8.1：`export default {...}` 纯数据）。
 * 缓存击穿：`pathToFileURL(resolved).href + '?t=' + now()`——Node 以**完整 URL（含查询串）**
 * 为 ESM 缓存键，同 t 会命中缓存拿到旧模块（实测钉死），所以热重载每次调用都要取新鲜 now；
 * 测试用注入的 `now` 保证查询串唯一。Windows 必须先转 file: URL，裸路径拼 `?t=` 无法 import。
 * 返回 default 导出的**原始值**（可能 undefined——缺 default 交给 validateConfig 报根错）；
 * 读不到/解析不了抛 ConfigLoadError（kind 分流），绝不用泛型 throw 混淆两种结局。
 * @param {string} filePath fs 路径（相对路径按 cwd 解析）
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<unknown>}
 */
// import() 报错的家族五花八门（Node 原生 ENOENT/ERR_MODULE_NOT_FOUND/SyntaxError；
// vitest 的模块跑器会把语法坏包成非 SyntaxError），所以"读不到"不靠猜 message——
// 判定权威顺序：先 fs 亲验文件在不在（unreadable 的确证），import 的错再按内核 IO 码
// 兜底（配置文件自身 import 别的东西缺失也算读不到），剩下的都归 unparsable：文件在、
// 模块出不来——半写坏语法，或求值期副作用抛（§8.1 本就禁止 import 副作用）。
const IO_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ERR_MODULE_NOT_FOUND']

// R33（审查轮 1 裁定）：异常文本在**构造点**净化，不在三个打印面（watch/cli/doctor）各配一份消毒剂。
// 实测故障形态（Node 24）：V8 会把输入切片嵌进 message——`JSON.parse('<非 JSON 开头串>')` 抛
// `Unexpected token 'x', "<输入窗口内切片>…" is not valid JSON`（切片窗口约 10 字符+省略号）；
// 配置文件求值期抛错时这句**原样**流经下面两个 new ConfigLoadError，再被 watch.js:175 打进日志、
// 被 run/doctor 打印——明文 key 落在求值路径上就会随消息外泄其头部。同仓先例姿态：
// lock.js 拒 rethrow parse 文本、core runner 在发射点 redact。净化只留三样：内核/模块 code、
// 错误 name、纯数字定位（position/line/column）——满足 Review Focus #1「指出行位」；
// 完整原文一律在 err.cause。
function summarizeThrown(err) {
  const code = err && typeof err.code === 'string' ? err.code : null
  const name = err && err.name ? String(err.name) : 'Error'
  const raw = err && err.message ? String(err.message) : ''
  const bits = []
  const at = raw.match(/at position (\d+)/i)
  if (at) bits.push('position ' + at[1])
  const lc = raw.match(/line (\d+)[,:] column (\d+)/i)
  if (lc) bits.push('line ' + lc[1] + ' column ' + lc[2])
  if (bits.length === 0) {
    // Node 编译错常见的尾部 `(file:///…:1:2)` 形态——只取两个数字，文件名本就等于 path 参数。
    const paren = raw.match(/[^()/]*?:(\d+):(\d+)\)?\s*$/)
    if (paren) bits.push('line ' + paren[1] + ' column ' + paren[2])
  }
  const label = code || name
  return bits.length > 0 ? label + '（' + bits.join('，') + '）' : label
}

export async function loadConfig(filePath, { now = Date.now } = {}) {
  const resolved = path.resolve(filePath)
  try {
    if (!fs.statSync(resolved).isFile()) {
      throw new ConfigLoadError('unreadable', filePath, '不是常规文件', null)
    }
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err
    // R33：detail 走净化摘要，原文（含内核消息里的任何内容）只进 cause。
    throw new ConfigLoadError('unreadable', filePath, summarizeThrown(err), err)
  }
  const href = pathToFileURL(resolved).href + '?t=' + now()
  let mod
  try {
    mod = await import(href)
  } catch (err) {
    const kind = err && IO_ERROR_CODES.includes(err.code) ? 'unreadable' : 'unparsable'
    // R33：求值期副作用抛的 message 是**原样透传**面（V8 可能内嵌输入切片，见 summarizeThrown 头注）。
    throw new ConfigLoadError(kind, filePath, summarizeThrown(err), err)
  }
  return mod && 'default' in mod ? mod.default : undefined
}
