// Prompt 组装 —— 把 bot 人格 + 房间上下文映射为 OpenAI chat/completions messages。
// 纯字符串/数组操作，无 IO，不依赖 Vue，不 import 其他 bot-core 模块。

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
 * @param {{ name: string, persona: string, override?: string }} opts
 * @returns {string}
 */
export function buildSystemPrompt({ name, persona, override }) {
  if (typeof override === 'string' && override.length > 0) return override
  return SYSTEM_TEMPLATE.replace('{name}', name).replace('{persona}', persona)
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
