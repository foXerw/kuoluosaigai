import { describe, it, expect } from 'vitest'
import {
  MAX_TEXT,
  clampText,
  buildSystemPrompt,
  buildMessages,
  SYSTEM_TEMPLATE,
  IDLE_KICK,
} from '../src/bots/prompt'

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
