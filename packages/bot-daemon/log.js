// Task 11：结构化 stdout 日志 —— 一行一条 JSON（journald 友好）+ apiKey 双策略脱敏（§8.2/A1/A3）。
//
// —— 线形 ——
// `{ts, level, botId?, kind?, msg, ...安全结构化字段}`：ts 注入时钟（缺省 Date.now），level
// ∈ info|warn|error，msg 恒在且恒为字符串；一行一对象一 \n。Q7/§8.2 级别映射：core 的
// LlmError(kind:'auth') → error（密钥退化要亮红）；rate 与非致命 kind（429 风暴/网络/TLS）→
// warn——runner 对**所有** LlmError 发 onEvent('error')（host 按 type 转发会原样落 error），
// 所以 error() 见到「非致命 kind + fatal:false」的载荷时降为 warn，429 风暴不许刷 error 屏。
// 两个入口等价：`event(type, payload)` 直接映射；host.js 转发形态的 `error(msg, fields)`
// 由同一判据降级。core 的 message 已被 B9 兜底（不含 apiKey），原样入列、不 widening。
//
// —— 双策略脱敏（本分支审查轮曾证单策略不足）——
// ①键名匹配 /key|token|secret/i 的字段值一律遮成 `sk-****` + slice(-4)（只活后四位，
//   不取前缀）；非字符串敏感值（对象/数组）整体 [masked]，其中嵌的字符串叶子**防御性注册**
//   进已知集。②已知 key 的**值**注册进集合，对一切自由文本（msg、其他字符串字段、字段名）
//   做全文替换——key 可以出现在 message 里，而不只出现在 apiKey 字段下。两把 key 在场必须
//   都遮（「只遮第一条」是钉死要防的失败形态）。注册表有界（64 条，**LRU 逐出**：重注册=
//   触摸后置，受害者只落从未再会的旧值——审查轮 1 Minor 1）：无常积累不许无限增长；操作者
//   的 key 数量远小于上限，逐出只影响超旧值。**调用内顺序无关**（审查轮 1 Important）：
//   注册与渲染在一行内交错，emit 对 buildLine 产物做终扫（knownSecrets 调用内单调不减，
//   终扫 ⊇ 一切中间时刻），任何「文本先渲、注册后到」的 caller 形态都不得漏出全值。
//
// —— sink 免疫（Task 1 parked 的 Critical-adjacent）——
// deck.js:609 一带**裸调**宿主汇、runner 在 catch 内发射：日志器抛错 = 24/7 进程里的
// unhandled rejection。所以每个公开方法整体裹 try，且序列化面逐层防御：BigInt/symbol/
// 函数转标记、循环引用 [circular]（按路径判环）、getter/ownKeys 抛错逐键 [unreadable]/跳过、
// 深度封顶 [truncated]、toString 炸 [unprintable]、write 自身炸（EPIPE/磁盘满）吞掉。
// 日志器死了没人能记下它死了，但 daemon 不能陪葬（host.js 同款纪律，本文件把它做进真身）。
//
// —— R33 的 .cause 纪律（陷阱本体，勿「顺手」拓宽）——
// 模块求值抛的 message 可以内嵌配置文件内容（V8 把 ~10 字符输入窗口拼进 JSON.parse 错误文本），
// R33 因此在 config.js 构造点净化：ConfigLoadError.message 只剩 name+纯数字定位，原文进 .cause。
// 本文件打印 cause 时**复用同一个过滤器**（config.js 导出的 summarizeThrown），绝不逐字输出
// cause.message、绝不复制 .stack（stack 头含 message）：cause 面只许 name/code/数字。
// 若将来想要更细的 cause 信息，仍然只许这三样，别自由文本开路。
//
// —— 接线 ——
// cli.js 缺省 logger = createLogger()（替换 safeConsoleLogger 顶位实现），注入 host/watcher/
// rpc 控制面。validate/doctor/run 的既有 print 文案是 Task 9/10 已验收的常量文本，不在本文件
// 职责内（它们经 config.js 构造点净化已 key-free，见各文件头）。

import { summarizeThrown } from './config.js'

const SECRET_KEY_RE = /key|token|secret/i // A1/A3：字段名命中即遮
const MIN_KNOWN_SECRET_LEN = 8 // 防御性注册下限：短串当 key 会误伤正常文本
const MAX_KNOWN_SECRETS = 64 // 已知值集合上限（FIFO 逐出）——无常积累不无限增长
const MAX_DEPTH = 6 // 嵌套封顶：防超深结构的递归爆栈绕过 try（RangeError 也能被吞，但别赌）

function maskOf(v) {
  return 'sk-****' + String(v).slice(-4) // 只活后四位，永不取前缀
}

/**
 * 创建结构化日志器。
 * @param {{
 *   write?: (s: string) => void,   // 缺省 process.stdout.write；注入面供测试与特殊 sink
 *   now?: () => number,            // 缺省 Date.now（注入假时钟；抛错则 ts 归零不外溢）
 *   redact?: (s: string) => string,// 可选自由文本钩子：默认脱敏**之后**追加执行；炸则回退默认结果
 * }} [options]
 * @returns {{ info: Function, warn: Function, error: Function, event: Function, knownSecretCount: () => number }}
 */
export function createLogger({ write, now = Date.now, redact = null } = {}) {
  const knownSecrets = new Set() // 已知敏感值原文 → 掩码（Set 迭代即插入序 = FIFO）
  const sink = typeof write === 'function' ? write : (s) => process.stdout.write(s)

  function register(v) {
    try {
      if (typeof v !== 'string' || v.length < MIN_KNOWN_SECRET_LEN) return
      // LRU 触摸（审查轮 1 Minor 1）：Set.add 对在场值是 no-op——不先删再加，持续在场的热
      // key 永远占着插入头部、被逐出殃及自身，一次性的过路值反而长驻。先删后加=重排到队尾，
      // 逐出只落「自上次在场以来从未再会」的最旧值。
      knownSecrets.delete(v)
      knownSecrets.add(v)
      while (knownSecrets.size > MAX_KNOWN_SECRETS) {
        knownSecrets.delete(knownSecrets.values().next().value)
      }
    } catch (e) {
      /* 防御性注册尽力而为：注册面炸不许带走日志行 */
    }
  }

  // 已知值全文替换（与钩子分离：供 build 期与终扫各自调用，redact 钩子只在 build 期单次生效，
  // 免得非幂等钩子被终扫跑第二遍）。
  function replaceKnown(s) {
    let out = s
    for (const v of knownSecrets) {
      if (out.indexOf(v) !== -1) out = out.split(v).join(maskOf(v))
    }
    return out
  }

  // 自由文本脱敏：先已知值全文替换，再过可选 redact 钩子（钩子炸回退默认结果）。
  function scrubText(s) {
    let out = replaceKnown(s)
    if (typeof redact === 'function') {
      try {
        const r = redact(out)
        if (typeof r === 'string') out = r
      } catch (e) {
        /* 钩子失败不丢行：保留默认脱敏结果 */
      }
    }
    return out
  }

  function safeString(v) {
    try {
      return String(v)
    } catch (e) {
      return '[unprintable]' // Symbol 走 String() 无事，Proxy/toString 炸才到这里
    }
  }

  // 敏感键的取值：原值注册进已知集（策略二的前提），输出只留掩码。对象/数组整体 [masked]，
  // 其中的字符串叶子尽力收集注册（防御性注册）。
  function maskSensitive(value) {
    if (value === null || value === undefined) return value
    const t = typeof value
    if (t === 'string') {
      register(value)
      return maskOf(value)
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') {
      const s = safeString(value)
      register(s)
      return maskOf(s)
    }
    if (t === 'object') collectLeaves(value, 0)
    return '[masked]'
  }

  function collectLeaves(value, depth) {
    try {
      if (value === null || typeof value !== 'object') {
        if (typeof value === 'string') register(value)
        return
      }
      if (depth > MAX_DEPTH) return
      for (const k of Object.keys(value)) collectLeaves(value[k], depth + 1)
    } catch (e) {
      /* getter/ownKeys 炸：该子树放弃注册，不外抛 */
    }
  }

  // Error 净化：name + message（自由文本仍过 scrubText）+ code + cause 摘要。
  // R33：cause 只出 summarizeThrown（name/code/纯数字），cause.message 原文与 .stack 永不入列。
  function scrubError(err) {
    const out = { name: safeString(err.name || 'Error'), message: scrubText(safeString(err.message)) }
    try {
      if (typeof err.code === 'string') out.code = scrubText(err.code) // 审查轮 1 Minor 2：code 面不豁免
    } catch (e) {
      /* code 是炸的 getter：没有 code，照常出 */
    }
    try {
      if (err.cause !== undefined && err.cause !== null) out.cause = safeString(summarizeThrown(err.cause))
    } catch (e) {
      out.cause = '[unsummarizable]'
    }
    return out
  }

  function scrub(value, depth, seen) {
    if (value === undefined) return undefined
    const t = typeof value
    if (t === 'string') return scrubText(value)
    if (t === 'number') return Number.isFinite(value) ? value : null
    if (t === 'boolean' || value === null) return value
    if (t === 'bigint') return '[bigint ' + safeString(value).slice(-4) + ']'
    if (t === 'symbol') return '[symbol]'
    if (t === 'function') return '[function]'
    try {
      if (value instanceof Error) return scrubError(value)
      if (value instanceof Date) return scrubText(value.toISOString())
      if (seen.has(value)) return '[circular]'
      if (depth >= MAX_DEPTH) return '[truncated]'
      seen.add(value)
      let out
      if (Array.isArray(value)) {
        out = []
        for (const item of value) {
          const sv = scrub(item, depth + 1, seen)
          out.push(sv === undefined ? null : sv) // 数组槽位不塌：undefined→null 与 JSON 语义一致
        }
      } else {
        out = {}
        for (const k of Object.keys(value)) {
          let v
          try {
            v = value[k]
          } catch (e) {
            out[scrubText(safeString(k))] = '[unreadable]' // getter 炸：键位保留、值不可得
            continue
          }
          const key = scrubText(safeString(k))
          const sv = SECRET_KEY_RE.test(k) ? maskSensitive(v) : scrub(v, depth + 1, seen)
          if (sv !== undefined) out[key] = sv
        }
      }
      seen.delete(value) // 按路径判环：兄弟共享同一对象不是环（JSON.stringify 也允许）
      return out
    } catch (e) {
      return '[unserializable]' // ownKeys trap 等结构性炸点
    }
  }

  function tsOf() {
    try {
      const t = now()
      return typeof t === 'number' && Number.isFinite(t) ? t : 0
    } catch (e) {
      return 0
    }
  }

  // Q7 判据的单一出处：kind==='auth' 或 fatal:true → error；其余带 kind 的非致命 LLM 事件 →
  // warn；无 kind（deck 配置告警/SLOW DOWN/接线方泛型 error）→ 跟随 type/入参级别。
  function coreLevel(type, payload) {
    try {
      const kind = payload && typeof payload === 'object' ? payload.kind : undefined
      const fatal = payload && typeof payload === 'object' ? payload.fatal : undefined
      if (kind === 'auth' || fatal === true) return 'error'
      if (typeof kind === 'string') return 'warn'
    } catch (e) {
      /* getter 载荷：按无 kind 处理 */
    }
    return type === 'error' ? 'error' : 'warn'
  }

  function buildLine(level, msg, fields) {
    const line = { ts: tsOf(), level: level }
    const has = fields !== null && fields !== undefined && typeof fields === 'object' && !Array.isArray(fields)
    let botId
    let kind
    if (has) {
      try {
        if ('botId' in fields) botId = fields.botId
        if ('kind' in fields) kind = fields.kind
      } catch (e) {
        /* 探测性读取炸了：键位缺席处理，不假装有值 */
      }
    }
    if (botId !== undefined) line.botId = scrub(botId, 0, new Set())
    if (kind !== undefined) line.kind = scrub(kind, 0, new Set())
    line.msg = scrubText(safeString(msg === undefined ? '' : msg))
    if (!has) return line
    let keys
    try {
      keys = Object.keys(fields)
    } catch (e) {
      return line // ownKeys trap：只剩稳定头字段
    }
    for (const k of keys) {
      if (k === 'botId' || k === 'kind' || k === 'msg' || k === 'ts' || k === 'level') continue
      let v
      try {
        v = fields[k]
      } catch (e) {
        line[scrubText(safeString(k))] = '[unreadable]'
        continue
      }
      const sv = SECRET_KEY_RE.test(k) ? maskSensitive(v) : scrub(v, 0, new Set())
      if (sv !== undefined) line[scrubText(safeString(k))] = sv
    }
    return line
  }

  // 审查轮 1 Important：渲染必须晚于**当次调用**的全部注册。buildLine 里注册与渲染交错
  // （msg/botId/kind 先渲、fields 循环后注册；同对象里 note 排在 apiKey 前；嵌套注册位更晚），
  // 单靠 pre-pass 要穷举一切注册位、未来新增注册点会静默重开洞。改为对已建 line 做终扫：
  // knownSecrets 在调用内单调不减 → 终扫看到的集合 ⊇ 任何中间时刻 → 任意 caller 形态、任意
  // 交错次序都顺序无关。line 已由 scrub 规约为无 getter、无循环、深度封顶的纯树，终扫是全函数
  // 不会抛；对已遮文本重跑 replaceKnown 是无操作或再遮——只会更安全。
  function scrubDeep(value) {
    if (typeof value === 'string') return replaceKnown(value)
    if (Array.isArray(value)) {
      const out = []
      for (const item of value) out.push(scrubDeep(item))
      return out
    }
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const k of Object.keys(value)) out[replaceKnown(k)] = scrubDeep(value[k])
      return out
    }
    return value
  }

  function emit(level, msg, fields) {
    try {
      const line = scrubDeep(buildLine(level, msg, fields))
      let text
      try {
        text = JSON.stringify(line)
      } catch (e) {
        text = JSON.stringify({ ts: line.ts, level: level, msg: '[log:line-unserializable]' })
      }
      sink(text + '\n') // write 自身炸（EPIPE/磁盘满/journald 抖动）由外层 try 吞——sink 免疫的最后一环
    } catch (e) {
      /* 日志器死了不许陪葬 daemon（Task 1 教训） */
    }
  }

  return {
    info(msg, fields) {
      try {
        emit('info', msg, fields)
      } catch (e) {
        /* 每方法独立兜底（双保险） */
      }
    },
    warn(msg, fields) {
      try {
        emit('warn', msg, fields)
      } catch (e) {
        /* 同上 */
      }
    },
    error(msg, fields) {
      try {
        // host.js 转发形态：core 对所有 LlmError 都走 error 通道，非致命 kind + fatal:false 降 warn。
        emit(coreLevel('error', fields), msg, fields)
      } catch (e) {
        /* 同上 */
      }
    },
    event(type, payload) {
      try {
        emit(coreLevel(type, payload), 'bot-core ' + safeString(type), payload)
      } catch (e) {
        /* 同上 */
      }
    },
    knownSecretCount() {
      return knownSecrets.size
    },
  }
}
