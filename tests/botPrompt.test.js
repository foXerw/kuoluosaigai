import { describe, it, expect } from 'vitest'
import {
  MAX_TEXT,
  clampText,
  buildSystemPrompt,
  buildMessages,
  buildTranscriptMessages,
  SYSTEM_TEMPLATE,
  IDLE_KICK,
} from 'kuoluosaigai-bot-core'

// 消息帧形状（Task 2/3 合同）：{ type:'message', id, ts, roomId, nick, badge, text }
const msg = (id, ts, nick = 'ANON-BBBB', badge = '', text = 'hi') => ({
  type: 'message',
  id,
  ts,
  roomId: 'r1',
  nick,
  badge,
  text,
})

describe('clampText', () => {
  it('非字符串(null/undefined/数字) → ""', () => {
    expect(clampText(null)).toBe('')
    expect(clampText(undefined)).toBe('')
    expect(clampText(42)).toBe('')
    expect(clampText({})).toBe('')
    expect(clampText(true)).toBe('')
  })

  it('trim 后 slice(0, MAX_TEXT)', () => {
    expect(clampText('  hello  ')).toBe('hello')
  })

  it('超长 → 截断至 280 字符', () => {
    const long = 'a'.repeat(400)
    expect(clampText(long).length).toBe(280)
    expect(clampText(long)).toBe('a'.repeat(280))
  })

  it('刚好 280 不截断', () => {
    const exactly = 'x'.repeat(280)
    expect(clampText(exactly)).toBe(exactly)
    expect(clampText(exactly).length).toBe(280)
  })

  it('短文本保持不变', () => {
    expect(clampText('hello')).toBe('hello')
  })

  it('MAX_TEXT == 280', () => {
    expect(MAX_TEXT).toBe(280)
  })
})

describe('buildSystemPrompt', () => {
  it('模板包含 name 和 persona 占位替换', () => {
    const result = buildSystemPrompt({ name: '小译', persona: '冷静的观察员' })
    expect(result).toContain('小译')
    expect(result).toContain('冷静的观察员')
  })

  it('模板含硬约束（≤280/短句/禁 markdown/不承认 AI）', () => {
    const result = buildSystemPrompt({ name: 'X', persona: 'Y' })
    expect(result).toMatch(/280/)
    expect(result).toMatch(/markdown|md|\*\*|#/)
    expect(result).toMatch(/AI|人工智能|助手|Bot/)
  })

  it('override 优先原样返回', () => {
    const custom = '我是一条完全自定义的 system prompt'
    expect(buildSystemPrompt({ name: 'X', persona: 'Y', override: custom })).toBe(custom)
  })

  it('override 空串 → 走模板', () => {
    const result = buildSystemPrompt({ name: 'A', persona: 'B', override: '' })
    expect(result).not.toBe('')
    expect(result).toContain('A')
  })

  it('override null/undefined → 走模板', () => {
    const withNull = buildSystemPrompt({ name: 'A', persona: 'B', override: null })
    const withUndef = buildSystemPrompt({ name: 'A', persona: 'B', override: undefined })
    expect(withNull).toContain('A')
    expect(withUndef).toContain('A')
  })
})

describe('buildMessages', () => {
  it('frames 为空时只返回 [system]', () => {
    const sys = '你是在聊天的 bot'
    const result = buildMessages({ system: sys, frames: [] })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'system', content: sys })
  })

  it('首条恒为 system', () => {
    const frames = [msg(1, 1)]
    const sys = 'you are a bot'
    const result = buildMessages({ system: sys, frames })
    expect(result[0].role).toBe('system')
    expect(result[0].content).toBe(sys)
  })

  it('nick === selfNick → assistant', () => {
    const frames = [msg(1, 1, 'ANON-AAAA')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
    })
    expect(result[1].role).toBe('assistant')
  })

  it('他人 → user', () => {
    const frames = [msg(1, 1, 'ANON-BBBB')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
    })
    expect(result[1].role).toBe('user')
  })

  it('content 前缀 NICK[BADGE]:（badge 非空）', () => {
    const frames = [msg(1, 1, 'ANON-BBBB', 'BOT·小白', 'hello')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
    })
    expect(result[1].content).toBe('ANON-BBBB[BOT·小白]: hello')
  })

  it('content 前缀 NICK:（badge 空则无括号）', () => {
    const frames = [msg(1, 1, 'ANON-BBBB', '', 'hello')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
    })
    expect(result[1].content).toBe('ANON-BBBB: hello')
  })

  it('取 frames 末尾 window=40 条', () => {
    const frames = Array.from({ length: 100 }, (_, i) => msg(i, i))
    const result = buildMessages({ system: 's', frames, window: 40 })
    // 应该有 1 条 system + 40 条消息
    expect(result).toHaveLength(41)
  })

  it('默认 window=40', () => {
    const frames = Array.from({ length: 100 }, (_, i) => msg(i, i))
    const result = buildMessages({ system: 's', frames })
    expect(result).toHaveLength(41) // 1 system + 40
  })

  it('window=0 只有 system', () => {
    const frames = [msg(1, 1)]
    const result = buildMessages({ system: 's', frames, window: 0 })
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('system')
  })

  it('idle=true 末尾追加 IDLE_KICK system 指令', () => {
    const frames = [msg(1, 1, 'ANON-BBBB')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
      idle: true,
    })
    const last = result[result.length - 1]
    expect(last.role).toBe('system')
    expect(last.content).toBe(IDLE_KICK)
  })

  it('idle=false 末尾没有额外 system', () => {
    const frames = [msg(1, 1, 'ANON-BBBB')]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-AAAA',
      idle: false,
    })
    expect(result).toHaveLength(2) // 1 system + 1 user
  })

  it('多人对话正确分配角色', () => {
    const frames = [
      msg(1, 1, 'ANON-A'),   // self
      msg(2, 2, 'ANON-B'),   // other
      msg(3, 3, 'ANON-A'),   // self
    ]
    const result = buildMessages({
      system: 's',
      frames,
      selfNick: 'ANON-A',
    })
    expect(result[1].role).toBe('assistant')
    expect(result[2].role).toBe('user')
    expect(result[3].role).toBe('assistant')
  })
})

describe('exported constants', () => {
  it('IDLE_KICK 是非空字符串', () => {
    expect(IDLE_KICK).toBeDefined()
    expect(typeof IDLE_KICK).toBe('string')
    expect(IDLE_KICK.length).toBeGreaterThan(0)
  })

  it('SYSTEM_TEMPLATE 是非空字符串', () => {
    expect(SYSTEM_TEMPLATE).toBeDefined()
    expect(typeof SYSTEM_TEMPLATE).toBe('string')
    expect(SYSTEM_TEMPLATE.length).toBeGreaterThan(0)
  })
})

describe('buildSystemPrompt few-shot（P4）', () => {
  it('默认注入 Tieba few-shot 头与不少于 30 条例句，原规则仍在', () => {
    const s = buildSystemPrompt({ name: 'X', persona: 'Y' })
    expect(s).toContain('只学语气')
    expect(s).toContain('不要照抄')
    const lines = s.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBeGreaterThanOrEqual(30)
    expect(s).toContain('280')
  })

  it('fewShot:false 不注入样例', () => {
    const s = buildSystemPrompt({ name: 'X', persona: 'Y', fewShot: false })
    expect(s).not.toContain('只学语气')
    expect(s).not.toContain('不要照抄')
  })

  it('override 逐字节返回，few-shot 也不注入', () => {
    const custom = '完全自定义'
    expect(buildSystemPrompt({ name: 'X', persona: 'Y', override: custom })).toBe(custom)
  })
})

describe('buildTranscriptMessages（P4 transcript 单条）', () => {
  const sys = 'SYS'
  const A = msg(1, 1, 'ANON-A', '', '第一句')
  const B = msg(2, 2, 'ANON-B', 'BOT·小白', '第二句')
  const S = msg(3, 3, 'ANON-SELF', '', '我自己说的')
  const C = msg(4, 4, 'ANON-C', '', '第三句')

  it('他人连续消息压成一条 user（带记录头/昵称/徽章），self 连续段为 assistant', () => {
    const out = buildTranscriptMessages({
      system: sys,
      frames: [A, B, S, C],
      selfNick: 'ANON-SELF',
      targetLen: 7,
    })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(out[1].content).toContain('[群聊记录 · 最近 3 条]')
    expect(out[1].content).toContain('ANON-A: 第一句')
    expect(out[1].content).toContain('ANON-B[BOT·小白]: 第二句')
    expect(out[2].content).toBe('我自己说的')
    expect(out[3].content).toContain('ANON-C: 第三句')
    expect(out[3].content).toContain('目标长度约 7 字')
    expect(out[3].content).toContain('[沉默]')
  })

  it('selfNick 为 null 时全部按他人处理，连续消息仍压成一条 user', () => {
    const out = buildTranscriptMessages({ system: sys, frames: [A, S], selfNick: null, targetLen: 9 })
    expect(out.map((m) => m.role)).toEqual(['system', 'user'])
    expect(out[1].content).toContain('ANON-SELF: 我自己说的')
  })

  it('window 生效（窗口外不出现）', () => {
    const frames = Array.from({ length: 60 }, (_, i) => msg(i, i, `ANON-${i}`, '', `m${i}`))
    const out = buildTranscriptMessages({ system: sys, frames, window: 10, targetLen: 9 })
    expect(out[1].content).not.toContain('m9\n')
    expect(out[1].content).toContain('m59')
    expect((out[1].content.match(/^ANON-/gm) || []).length).toBe(10)
  })

  it('idle：冷场主动发起指令', () => {
    const out = buildTranscriptMessages({
      system: sys,
      frames: [A],
      selfNick: 'ANON-SELF',
      targetLen: 6,
      idle: true,
    })
    const last = out[out.length - 1]
    expect(last.content).toContain('冷场')
    expect(last.content).toContain('主动')
  })

  it('drowsy：迷糊/更短指令，且目标字数被压到 ≤8', () => {
    const out = buildTranscriptMessages({
      system: sys,
      frames: [A],
      selfNick: 'ANON-SELF',
      targetLen: 29,
      drowsy: true,
    })
    const last = out[out.length - 1]
    expect(last.content).toContain('迷糊')
    expect(last.content).toContain('更短')
    expect(last.content).toContain('目标长度约 8 字')
  })

  it('空 frames 也给出 user 指令（idle 可用）；window=0 同理', () => {
    const empty = buildTranscriptMessages({ system: sys, frames: [], selfNick: 'X', targetLen: 5 })
    expect(empty.map((m) => m.role)).toEqual(['system', 'user'])
    const zero = buildTranscriptMessages({ system: sys, frames: [A], selfNick: 'X', window: 0, targetLen: 5 })
    expect(zero.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('单条消息同样截断到 280', () => {
    const long = msg(9, 9, 'ANON-L', '', 'x'.repeat(400))
    const out = buildTranscriptMessages({ system: sys, frames: [long], selfNick: 'X', targetLen: 5 })
    expect(out[1].content).toContain('x'.repeat(280))
    expect(out[1].content).not.toContain('x'.repeat(281))
  })

  it('最后一条是 self 时，footer 作为新的 user 轮追加', () => {
    const out = buildTranscriptMessages({ system: sys, frames: [A, S], selfNick: 'ANON-SELF', targetLen: 5 })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(out[out.length - 1].content).toContain('目标长度约 5 字')
  })
})
