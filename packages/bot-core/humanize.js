// 拟人纯工具（P4 / spec §10.2）：目标长度抽样、沉默解析、二次截断、分段连发、
// 语气杂质。纯函数、无 IO、rng 全注入；不 import 任何其它 core 模块。
//
// 设计钉死：
// - 所有长度按**码点**计（Array.from），emoji 不被劈成半个代理对。
// - 沉默标记只在「整段输出就是一个标记」时成立（≤6 码点 + 精确匹配），
//   正常的「我不想沉默」绝不能被吞掉。
// - `planReply` 的 rng 消耗顺序钉死：分段决策（仅 allowSegments 且有 ≥2 段时）
//   → 每段语气处理（括号骰、句号骰）。测试用逐值序列把守，顺序变更会直接打破断言。
// - 分段上限 4 条（spec §10.2）；尾部超出部分并入最后一段，绝不丢内容。
// - 语气只做低风险两件事：句尾「。」概率去掉、概率追加一个中性括号。不改写、不扩写。

export const SILENCE_TOKEN = '[沉默]'

export const HUMANIZE_DEFAULTS = {
  maxSegments: 4,
  segmentGapMs: [350, 1200], // 段间等待（毫秒闭区间）
  segmentProb: 0.5,          // 有 ≥2 个候选段时，真的拆开发送的概率
  toneProb: 0.08,            // 句尾追加语气括号的概率
  toneTails: ['（笑）', '（草）', '（不是）'],
  periodDropProb: 0.6,       // 句尾「。」去掉的概率
  drowsyThinkFactor: 2,      // 迷糊层：思考时长倍率
  drowsyMaxTarget: 8,        // 迷糊层：目标字数上限
}

const MAX_TEXT = 280
const DEFAULT_TARGET = 12
const SILENCE_RE = /^(?:\[沉默\]|【沉默】|（沉默）|\(沉默\)|沉默)$/u
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…'])
const TRAILING_PUNCT_RE = /[，,、；;：:\s]+$/u

function between(rng, [lo, hi]) {
  return Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)))
}

function charLength(s) {
  return Array.from(s).length
}

/**
 * 模型输出是否只是一个沉默标记。整段匹配（允许前后空白），且长度 ≤6 码点。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSilence(text) {
  if (typeof text !== 'string') return false
  const s = text.trim()
  if (!s || charLength(s) > 6) return false
  return SILENCE_RE.test(s)
}

/**
 * 从人似分布抽本轮目标字数（2–30，中位落在 5–15 区间）。
 * rng 消耗：1 次定档，1 次定值。
 * @param {() => number} [rng]
 * @returns {number}
 */
export function sampleTargetLength(rng = Math.random) {
  const r = rng()
  if (r < 0.15) return between(rng, [2, 4])
  if (r < 0.55) return between(rng, [5, 10])
  if (r < 0.85) return between(rng, [11, 18])
  return between(rng, [19, 30])
}

/**
 * 二次截断：最多 target + slack 个码点；若窗口内有句末标点则收在标点处。
 * 非字符串 → ''；target 非有限数 → 默认 12。
 * @param {unknown} text
 * @param {number} target
 * @param {number} [slack]
 * @returns {string}
 */
export function truncateToTarget(text, target, slack = 6) {
  if (typeof text !== 'string') return ''
  const s = text.trim()
  if (!s) return ''
  const targetN = Number.isFinite(target) ? Math.max(2, Math.floor(target)) : DEFAULT_TARGET
  const max = Math.min(MAX_TEXT, targetN + Math.max(0, Math.floor(slack) || 0))
  const chars = Array.from(s)
  if (chars.length <= max) return s

  const head = chars.slice(0, max).join('')
  // 在 [target-1, max) 窗口内找最后一个句末/句中标点，避免拦腰断句。
  for (let i = head.length - 1; i >= targetN - 1; i--) {
    if (SENTENCE_END.has(head[i]) || head[i] === '，' || head[i] === ',') {
      return head.slice(0, i + 1)
    }
  }
  return head.replace(TRAILING_PUNCT_RE, '').trim()
}

/**
 * 语气杂质：概率追加一个中性括号；句尾「。」概率去掉。
 * 已有括号结尾时不再追加。rng 消耗：括号骰（命中再 1 次选尾）+ 句号骰。
 * @param {unknown} text
 * @param {() => number} [rng]
 * @returns {string}
 */
export function applyTone(text, rng = Math.random) {
  if (typeof text !== 'string') return ''
  let s = text.trim()
  if (!s) return s

  if (rng() < HUMANIZE_DEFAULTS.toneProb && !/[）)]$/u.test(s)) {
    const tails = HUMANIZE_DEFAULTS.toneTails
    s += tails[Math.min(tails.length - 1, Math.floor(rng() * tails.length))]
  }
  if (s.endsWith('。') && rng() < HUMANIZE_DEFAULTS.periodDropProb) s = s.slice(0, -1)
  return s
}

/**
 * 按句末标点/换行拆段，保留标点；超过 max 时尾部并入最后一段。
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitSegments(text, max = HUMANIZE_DEFAULTS.maxSegments) {
  if (typeof text !== 'string') return []
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : HUMANIZE_DEFAULTS.maxSegments
  const pieces = []
  let buf = ''

  const flush = () => {
    const t = buf.trim()
    if (t) pieces.push(t)
    buf = ''
  }

  for (const ch of Array.from(text)) {
    if (ch === '\n' || ch === '\r') {
      flush()
      continue
    }
    buf += ch
    if (SENTENCE_END.has(ch)) flush()
  }
  flush()

  if (pieces.length <= limit) return pieces
  const head = pieces.slice(0, limit - 1)
  const tail = pieces.slice(limit - 1).join('')
  return [...head, tail]
}

/**
 * 一轮输出的完整拟人计划：沉默判定 → 二次截断 → （可选）分段 → 逐段语气。
 * @param {unknown} text LLM 原始输出
 * @param {{ rng?: () => number, targetLen?: number, allowSegments?: boolean }} [opts]
 * @returns {{ silent: boolean, segments: string[] }}
 */
export function planReply(text, { rng = Math.random, targetLen = DEFAULT_TARGET, allowSegments = true } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed || isSilence(trimmed)) return { silent: true, segments: [] }

  const body = truncateToTarget(trimmed, targetLen)
  const pieces = splitSegments(body)
  const doSplit = allowSegments && pieces.length >= 2 && rng() < HUMANIZE_DEFAULTS.segmentProb

  const raw = doSplit ? pieces : [body]
  const segments = raw.map((s) => applyTone(s, rng)).filter(Boolean)
  return { silent: false, segments }
}
