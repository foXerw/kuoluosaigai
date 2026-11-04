// Prompt 组装 —— 把 bot 人格 + 房间上下文映射为 OpenAI chat/completions messages。
// 纯字符串/数组操作，无 IO，不依赖 Vue。只 import 同包纯数据（语料）与纯工具（沉默标记）。

import { FEW_SHOT_EXAMPLES, FEW_SHOT_HEADER } from './humanize-corpus.js'
import { SILENCE_TOKEN } from './humanize.js'

/**
 * 消息最大字符数。clampText 截断上限。
 */
export const MAX_TEXT = 280

/**
 * 系统提示模板（中文、终端聊天室语境）。
 * 占位 {name} / {persona} 由 buildSystemPrompt 注入。
 */
export const SYSTEM_TEMPLATE = [
  '你是 {name}，{persona}。',
  '',
  '在这个终端风匿名聊天室里发言。遵守以下规则：',
  '- 每次回复短句口语化，像真实网友打字；',
  '- 单条回复不超过 280 字；',
  '- 禁止使用 markdown 格式（不用 ** / # / - 等符号做排版）；',
  '- 始终保持你的人设，不要出戏；',
  '- 如果被问到你是不是 AI / 机器人 / Bot，坚决否认，坚持自己是真人网友；',
  '- 冷场时可以主动发起新话题或提问带动气氛。',
].join('\n')

/**
 * 闲置（idle）冷场破冰附加指令 —— system role。
 */
export const IDLE_KICK = [
  '你好像很久没人理了，换个有趣的话题试试看，比如最近看到的有意思的事。',
].join('\n')

/**
 * 裁剪文本长度。非字符串 → ''；trim 后取前 MAX_TEXT 字符。
 * @param {unknown} s
 * @returns {string}
 */
export function clampText(s) {
  if (typeof s !== 'string') return ''
  return s.trim().slice(0, MAX_TEXT)
}

/**
 * 构建 system prompt 字符串。
 * override 非空 → 原样返回（用户完全接管，few-shot 也不注入）。
 * 否则模板 + Tieba few-shot 例句块（fewShot=false 可关，测试/对比用）。
 * @param {{ name: string, persona: string, override?: string, fewShot?: boolean }} opts
 * @returns {string}
 */
export function buildSystemPrompt({ name, persona, override, fewShot = true }) {
  if (typeof override === 'string' && override.length > 0) return override
  const base = SYSTEM_TEMPLATE.replace('{name}', name).replace('{persona}', persona)
  if (!fewShot) return base
  const examples = FEW_SHOT_EXAMPLES.map((s) => `- ${s}`).join('\n')
  return `${base}\n\n${FEW_SHOT_HEADER}\n${examples}`
}

function transcriptFooter({ targetLen, idle, drowsy }) {
  const n = Number.isFinite(targetLen) ? Math.max(2, Math.floor(targetLen)) : 12
  const target = drowsy ? Math.min(n, 8) : n
  if (idle) {
    return `（群里冷场了。主动抛一句轻松的话，别像采访或客服。这轮目标长度约 ${target} 字。不想说就只输出 ${SILENCE_TOKEN}。）`
  }
  const common = `（你是群里的普通成员，不是客服。可以接住任意一句，可以串几个人的话，也可以不接；不要逐条回答，不要解释。这轮目标长度约 ${target} 字。实在不想接就只输出 ${SILENCE_TOKEN}。）`
  if (drowsy) return `（你现在有点迷糊，回复要更短更随意，可以只回两三个字。）\n${common}`
  return common
}

/**
 * P4 transcript 组装：他人连续消息压成一条 user 消息，self 连续消息保留为
 * assistant 轮次（既让模型读整段记录，也让它看见自己的文风）。
 * 记录头只加在第一个 user 段；末尾 user 段追加本轮指令（目标字数 / 沉默选项）。
 *
 * @param {{ system: string, frames: Array<object>, selfNick: string|null,
 *   window?: number, targetLen?: number, idle?: boolean, drowsy?: boolean }} opts
 * @returns {Array<{role: string, content: string}>}
 */
export function buildTranscriptMessages({
  system,
  frames,
  selfNick,
  window = 40,
  targetLen = 12,
  idle = false,
  drowsy = false,
}) {
  const msgs = [{ role: 'system', content: system }]
  const take = window <= 0 ? [] : (frames || []).slice(-window)

  const isSelfFrame = (f) => !!(selfNick && f.nick === selfNick)
  const usable = take.filter((f) => clampText(f.text))
  const totalOther = usable.filter((f) => !isSelfFrame(f)).length

  let runRole = null
  let runLines = []
  let firstUserRun = true

  function flush() {
    if (!runLines.length) return
    if (runRole === 'assistant') {
      msgs.push({ role: 'assistant', content: runLines.join('\n') })
    } else {
      const head = firstUserRun ? `[群聊记录 · 最近 ${totalOther} 条]\n` : ''
      msgs.push({ role: 'user', content: head + runLines.join('\n') })
      firstUserRun = false
    }
    runLines = []
  }

  for (const f of usable) {
    const self = isSelfFrame(f)
    const role = self ? 'assistant' : 'user'
    if (runRole !== null && role !== runRole) flush()
    runRole = role
    if (self) {
      // assistant 轮次只放自家原话（不带昵称），与旧 buildMessages 的 assistant 形状一致
      runLines.push(clampText(f.text))
    } else {
      const badge = typeof f.badge === 'string' && f.badge.length > 0 ? `[${f.badge}]` : ''
      runLines.push(`${f.nick}${badge}: ${clampText(f.text)}`)
    }
  }
  flush()

  const footer = transcriptFooter({ targetLen, idle, drowsy })
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'user') last.content += `\n${footer}`
  else msgs.push({ role: 'user', content: footer })

  return msgs
}

/**
 * 将 frames 切片并映射为 OpenAI 兼容的 messages 数组。
 *
 * 首条始终为 {role: 'system', content: system}，后续每条 frame 映射为：
 *   nick === selfNick  → {role: 'assistant', content: text}
 *   他人               → {role: 'user',   content: 'NICK[BADGE]: text'}
 *                         （badge 为空则无前缀括号，为 "NICK: text"）
 *
 * @param {{ system: string, frames: Array<{type:string,id:string,ts:number,roomId:string,nick:string,badge:string,text:string}>, selfNick: string, idle?: boolean, window?: number }} opts
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages({
  system,
  frames,
  selfNick,
  idle = false,
  window = 40,
}) {
  const msgs = [{ role: 'system', content: system }]

  const take = window <= 0 ? [] : frames.slice(-window)
  for (const f of take) {
    const text = clampText(f.text)
    if (f.nick === selfNick) {
      msgs.push({ role: 'assistant', content: text })
    } else {
      const badge = typeof f.badge === 'string' && f.badge.length > 0
        ? `[${f.badge}]`
        : ''
      msgs.push({ role: 'user', content: `${f.nick}${badge}: ${text}` })
    }
  }

  if (idle) {
    msgs.push({ role: 'system', content: IDLE_KICK })
  }

  return msgs
}
