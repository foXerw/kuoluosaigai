// Task 5：state.json 旁挂存储适配器（裁定 §16.5 Q2）——apiKey 落盘前剥离 + 孤儿身份保留。
//
// —— 为什么有这个文件 ——
// daemon 的配置是用户手写的 ESM 文件，daemon **永不回写它**（Q2：回写毁注释、且 env 求值
// 结果会被冻结成盘上明文密钥）。但 deck 有必须落盘的可变状态（服务器分配的 ANON 昵称、
// lifetime token 账），Q2 裁定其落数据目录的旁挂 state.json——core 的 storage 端口在
// daemon 侧就接这个文件。
//
// —— R4 命名：接线方式（下一个实现者请先读这句）——
// createFileStateStore 的返回值就是 plan 里说的 `store`——core 的 storage 端口是**它本身**：
// Task 7 写 `createDeck({ storage: store, ... })`（storage ← store，不是它的某个子字段；
// getItem/setItem/removeItem 三方法即端口形状，readOrphans/path 是给 daemon 宿主用的额外
// 端口，core 不认识、也不会去读）。
//
// —— 为什么剥 key 只能发生在本适配器（别去改 core）——
// deck.persist() 的 providers 条目是 pick(p, PROVIDER_KEYS)，**含 apiKey**——所以到达
// setItem 的字符串每一次都带活 key。浏览器侧把 key 存进本地 storage 是有意语义
// （「key 只活在用户自己机器上」，A1），改 core 会破坏它；daemon 的落盘剥离因此只能做在
// 这一层。A1/A3 红线：完整 key 不得出现在 state.json、任何日志行、或本模块能产生的任何
// 异常文本里（连 JSON.parse 的报错都可能内嵌输入切片，所以畸形输入一律静默丢弃、绝不 rethrow）。
//
// —— 文件形状（Q2：配置拥有定义、state 拥有身份与账目）——
// {version, providers:[{id,name,baseUrl}], bots:[{id,nick}], lifetime:{}, orphans:{}}。
// bots 剥到 {id,nick}：name/persona/room 等定义归配置文件，落盘即越权（且重启后由 Task 7
// 调和回灌）。core 的 loadInto 只认 version/providers/bots/lifetime，多余的 orphans 顶层键
// 本就会被忽略——但我们仍在 getItem 供入层再剥一次：orphans 永不回流进 core 读到的载荷
// （纵深防御，Task 7 只经 readOrphans() 取它）。
//
// —— 孤儿身份保留（Q2：误删配置不得丢身份，防手滑删除）——
// core.removeBot 会连 lifetime[id] 一起删再 persist——朴素透传会把服务器分配的 ANON-XXXX
// 与 token 账同时丢掉。所以每次写入都与「上一次写入的完整文档」比较（内存缓存优先，无缓存
// 读盘为基准——重启后停机期间被删的 id 照样收拢）：消失的 id 把 {nick, lifetime} 存进
// orphans[id]；同 id 再现时由 Task 7 经 readOrphans() 复用（updateBot(id,{nick})）。
// 退役规则：仅当载荷已**完整携带**该 id 的昵称与账目，孤儿条目才退役——再现但身份尚未回填
// 的窗口（addBot 与 updateBot 之间崩溃）必须保留，否则「保留机制」本身反而成了一次身份销毁。
// 二次消失且旧条目在场：账目并账（deck 对再添加的 bot 从零记账，两段账不相交，相加=总量），
// nick 只升不降（载荷为空则沿用旧值）。
//
// —— 失败语义（两种都不许崩 daemon）——
// 读：缺文件 / 坏 JSON / IO 失败 → getItem 返回 null（交给 core 的 B15 空重建）。
// 缺与坏在盘上无法区分（读到的都是 throw 或垃圾文本），适配器统一回 null，不抛。
// 写：输入不是合法载荷（非 JSON / 非对象 / 数组）→ 静默忽略，原文绝不落盘（原文可能带 key）；
// 真 IO 故障（写盘/改名失败）→ 原样上抛，core 的 persist try/catch（B17）接住并标
// storageDegraded——写失败**不被吞掉**是刻意选择：吞了 core 就失去降级信号。抛出的错误文本
// 只含路径与内核消息，不含载荷内容（A3）。

import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_KEY, SCHEMA_VERSION } from 'kuoluosaigai-bot-core'

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// null-as-absent，对齐 core normalizeCfg：空串昵称视同缺席。
function normNick(v) {
  return typeof v === 'string' && v ? v : null
}

// 账目归一：非对象一律 null（缺席），在场则两端点收数字——对齐 core loadInto 的清洗。
function normLedger(v) {
  if (!isObject(v)) return null
  return { promptTokens: Number(v.promptTokens) || 0, completionTokens: Number(v.completionTokens) || 0 }
}

/**
 * 载荷净化到盘形状：白名单逐字段拷贝，apiKey 在**结构上**无法存活（不是置空，是根本不
 * 认识那个键）。对已净化的文档幂等——getItem 供入层用同一把刀再过一遍，手改文件的
 * 夹带也进不了 core 视野。version 恒盖 SCHEMA_VERSION（从 core 导入，不硬编码）。
 */
function sanitizePayload(payload) {
  const out = { version: SCHEMA_VERSION, providers: [], bots: [], lifetime: {} }
  for (const p of Array.isArray(payload.providers) ? payload.providers : []) {
    if (!isObject(p) || typeof p.id !== 'string') continue
    out.providers.push({ id: p.id, name: p.name ?? null, baseUrl: p.baseUrl ?? null })
  }
  for (const b of Array.isArray(payload.bots) ? payload.bots : []) {
    if (!isObject(b) || typeof b.id !== 'string') continue
    out.bots.push({ id: b.id, nick: normNick(b.nick) })
  }
  if (isObject(payload.lifetime)) {
    for (const [id, v] of Object.entries(payload.lifetime)) {
      const lt = normLedger(v)
      if (lt !== null) out.lifetime[id] = lt
    }
  }
  return out
}

function readTextOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return null // 缺文件与 IO 失败统一 null：读路径永不抛（daemon 不许崩）
  }
}

/**
 * 文本 → 顶层对象；任何异常形态（非字符串 / 坏 JSON / 标量 / 数组）→ null。
 * 刻意不抛也不记录 JSON.parse 的报错文本——V8 的 SyntaxError message 可能内嵌输入切片
 * （A3：key 不得进日志/异常）。
 */
function parseDocOrNull(text) {
  if (typeof text !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  return isObject(parsed) ? parsed : null
}

/**
 * 建文件态存储（plan 里的 `store`；R4：Task 7 以 `storage: store` 注入 createDeck）。
 * @param {{ dir: string, fileName?: string }} options dir = 数据目录（Task 6 锁文件同级），
 *   不存在则在首次写入时递归创建。
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function, readOrphans: Function, path: string }}
 */
export function createFileStateStore({ dir, fileName = 'state.json' }) {
  const filePath = path.join(dir, fileName)
  const tmpPath = filePath + '.tmp'
  let lastDoc = null // 上次成功写入的完整文档（含 orphans）内存副本；null → 读盘为基准

  function baseline() {
    if (lastDoc === null) lastDoc = parseDocOrNull(readTextOrNull(filePath))
    return lastDoc
  }

  /**
   * 与上次写入比较，收拢消失 id 的 {nick, lifetime}，并让被载荷完整接管的条目退役。
   * prev 为净化后的盘文档（bots 条目只剩 {id,nick}，账目在 prev.lifetime）；
   * payload 为净化后的新载荷。返回的 orphans 只进盘，不进 getItem 供入面。
   */
  function computeOrphans(prev, payload) {
    const orphans = {}
    if (prev && isObject(prev.orphans)) {
      for (const [id, o] of Object.entries(prev.orphans)) {
        if (!isObject(o)) continue
        orphans[id] = { nick: normNick(o.nick), lifetime: normLedger(o.lifetime) }
      }
    }
    const nextById = new Map()
    for (const b of payload.bots) nextById.set(b.id, b)
    const prevBots = prev && Array.isArray(prev.bots) ? prev.bots : []
    const prevLifetime = prev && isObject(prev.lifetime) ? prev.lifetime : {}
    // 消失 → 入册。nick 只升不降（新值为空则沿用旧册）；账目新旧并存时并账（见文件头论证）。
    for (const b of prevBots) {
      if (!isObject(b) || typeof b.id !== 'string' || nextById.has(b.id)) continue
      const old = orphans[b.id]
      const fresh = normLedger(prevLifetime[b.id])
      const nick = normNick(b.nick) !== null ? normNick(b.nick) : old ? old.nick : null
      let lifetime = null
      if (fresh !== null && old && old.lifetime !== null) {
        lifetime = {
          promptTokens: old.lifetime.promptTokens + fresh.promptTokens,
          completionTokens: old.lifetime.completionTokens + fresh.completionTokens,
        }
      } else if (fresh !== null) {
        lifetime = fresh
      } else if (old) {
        lifetime = old.lifetime
      }
      if (nick === null && lifetime === null) continue // 无可保留的身份也没有账目，不造空条目
      orphans[b.id] = { nick, lifetime }
    }
    // 再现且载荷已完整携带昵称与账目 → 退役；账目不缺的 id 若载荷缺账目则保留（别让退役动作
    // 反而丢账目——deck 对再添加的 bot 从零记账，旧账此刻只活在 orphans 里）。
    for (const id of Object.keys(orphans)) {
      const b = nextById.get(id)
      if (!b || b.nick === null) continue
      const carried = normLedger(payload.lifetime[id])
      if (carried !== null || orphans[id].lifetime === null) delete orphans[id]
    }
    return orphans
  }

  function setItem(k, v) {
    if (k !== CONFIG_KEY) return // daemon 侧没有第二个 deck 键：其它键的写一律忽略
    const parsed = parseDocOrNull(typeof v === 'string' ? v : null)
    if (parsed === null) return // 非法输入静默丢弃——原文（可能含 key）绝不落盘
    const payload = sanitizePayload(parsed)
    const doc = {
      version: SCHEMA_VERSION,
      providers: payload.providers,
      bots: payload.bots,
      lifetime: payload.lifetime,
      orphans: computeOrphans(baseline(), payload),
    }
    let moved = false
    try {
      fs.mkdirSync(dir, { recursive: true }) // 数据目录归本适配器管：写入时确保存在
      fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n')
      fs.renameSync(tmpPath, filePath) // 原子：Windows Node 的 rename 自带 REPLACE_EXISTING
      moved = true
      lastDoc = doc // 失败不污染基准：下轮比较仍对上一次真正落盘的内容
    } finally {
      if (!moved) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) // 不留 .tmp 残骸
        } catch (e) {
          /* 尽力清理；清理失败不掩盖原始异常 */
        }
      }
    }
  }

  function getItem(k) {
    if (k !== CONFIG_KEY) return null
    const doc = parseDocOrNull(readTextOrNull(filePath))
    if (doc === null) return null // 缺文件与坏 JSON 在盘上无从区分，统一交给 core B15
    // 供入层再净化一次：orphans 绝不回流，手改文件里的越形状键也进不了 core 视野。
    return JSON.stringify(sanitizePayload(doc))
  }

  function removeItem(k) {
    if (k !== CONFIG_KEY) return // core 实际只用 get/set（deck 无 removeItem 调用点）；端口形状完整起见实现
    lastDoc = null
    // localStorage.removeItem 的忠实物：整文件删除（orphans 随之——这是**显式抹除**，
    // 语义不同于「误删配置」，Q2 的身份保护走的是 computeOrphans，不依赖这条路径）。
    fs.rmSync(filePath, { force: true })
  }

  function readOrphans() {
    const doc = parseDocOrNull(readTextOrNull(filePath))
    const out = {}
    if (doc && isObject(doc.orphans)) {
      for (const [id, o] of Object.entries(doc.orphans)) {
        if (!isObject(o)) continue
        out[id] = { nick: normNick(o.nick), lifetime: normLedger(o.lifetime) }
      }
    }
    return out // Task 7 消费：boot 时按 id 复用 nick（updateBot(id,{nick})）
  }

  return {
    getItem,
    setItem,
    removeItem,
    readOrphans,
    path: filePath,
  }
}
