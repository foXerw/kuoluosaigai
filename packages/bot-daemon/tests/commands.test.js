import { describe, it, expect, vi } from 'vitest'
import { createCommandHandler, buildDevState, keyHintOf, REMOTE_COMMANDS } from '../commands.js'

function fakeDeck() {
  const bot = {
    id: 'bot-a', name: '小李', persona: 'p', chattiness: 50, temperature: 0.9,
    roomId: 'nebula', providerId: 'daemon', model: 'm',
    rt: { roomId: 'nebula', status: 'open', nick: 'ANON-AAAA', hourCount: 2, session: { promptTokens: 1, completionTokens: 2, messages: 3 } },
  }
  const calls = []
  const deck = {
    bots: [bot],
    lifetime: { 'bot-a': { promptTokens: 10, completionTokens: 20 } },
    calls,
    persist: vi.fn(() => { calls.push(['persist']) }),
    addBot: vi.fn((cfg) => { calls.push(['add', cfg]); return { ok: true } }),
    updateBot: vi.fn((id, patch) => { calls.push(['update', id, patch]); return { ok: true } }),
    removeBot: vi.fn((id) => { calls.push(['remove', id]) }),
    startBot: vi.fn(async (id) => { calls.push(['start', id]); return true }),
    stopBot: vi.fn((id) => { calls.push(['stop', id]) }),
    switchBotRoom: vi.fn((id, room) => {
      calls.push(['switch', id, room])
      const b = deck.bots.find((x) => x.id === id)
      if (b) { b.roomId = room; b.rt.roomId = room }
      return true
    }),
    clearBotBuffer: vi.fn((id) => { calls.push(['clear', id]) }),
  }
  return deck
}

const cfg = {
  provider: { model: 'deepseek-chat', baseUrl: 'https://api.example/v1' },
  bots: [{ id: 'bot-a', name: '小李', persona: 'p', room: 'nebula' }],
}

function make(over = {}) {
  const deck = fakeDeck()
  const runtime = {
    setRoomOverride: vi.fn(() => true),
    clearRoomOverride: vi.fn(),
    getRoomOverride: vi.fn(() => null),
  }
  const handler = createCommandHandler({
    deck,
    runtime,
    getConfig: () => cfg,
    logger: { warn() {}, info() {} },
    ...over,
  })
  return { deck, runtime, handler }
}

describe('createCommandHandler', () => {
  it('deck.get 与 start/stop/remove/buffer.clear 走 deck', async () => {
    const { deck, handler } = make()
    expect(handler.handle({ cmd: 'deck.get', args: {} })).toEqual({ ok: true, err: null })
    expect(handler.handle({ cmd: 'bot.start', args: { id: 'bot-a' } })).toEqual({ ok: true, err: null })
    await Promise.resolve()
    expect(deck.startBot).toHaveBeenCalledWith('bot-a')
    expect(handler.handle({ cmd: 'bot.stop', args: { id: 'bot-a' } })).toEqual({ ok: true, err: null })
    expect(handler.handle({ cmd: 'buffer.clear', args: { id: 'bot-a' } })).toEqual({ ok: true, err: null })
    const beforeRemove = deck.calls.length
    expect(handler.handle({ cmd: 'bot.remove', args: { id: 'bot-a' } })).toEqual({ ok: true, err: null })
    expect(deck.stopBot).toHaveBeenCalledWith('bot-a')
    expect(deck.removeBot).toHaveBeenCalledWith('bot-a')
    expect(deck.clearBotBuffer).toHaveBeenCalledWith('bot-a')
    // lifetime 冲刷必须先于 removeBot（core 有 10s 节流）：只看 remove 这一段调用序
    expect(deck.calls.slice(beforeRemove).map((c) => c[0])).toEqual(['persist', 'stop', 'remove'])
  })

  it('bot.add 用配置 model/provider，且不接受 apiKey', () => {
    const { deck, handler } = make()
    const r = handler.handle({
      cmd: 'bot.add',
      args: { id: 'bot-b', name: '阿强', persona: 'p', room: 'amber', chattiness: 70 },
    })
    expect(r).toEqual({ ok: true, err: null })
    expect(deck.addBot).toHaveBeenCalledWith(expect.objectContaining({
      id: 'bot-b', name: '阿强', roomId: 'amber', providerId: 'daemon', model: 'deepseek-chat',
    }))
    expect(handler.handle({ cmd: 'bot.add', args: { id: 'x', name: 'n', persona: 'p', room: 'nebula', apiKey: 'sk-x' } }))
      .toEqual({ ok: false, err: 'bad args' })
    expect(handler.handle({ cmd: 'bot.add', args: { id: 'x', name: 'n', persona: 'p', room: 'nebula', nested: { apiKey: 'sk-x' } } }))
      .toEqual({ ok: false, err: 'bad args' })
    // 重复 id：core addBot 不去重，命令层必须先拒
    expect(handler.handle({ cmd: 'bot.add', args: { id: 'bot-a', name: '另一个', persona: 'p', room: 'nebula' } }))
      .toEqual({ ok: false, err: 'exists' })
  })

  it('bot.update 只允许定义字段；apiKey/未知字段拒绝', () => {
    const { deck, handler } = make()
    expect(handler.handle({ cmd: 'bot.update', args: { id: 'bot-a', persona: '新人格', chattiness: 80 } }))
      .toEqual({ ok: true, err: null })
    expect(deck.updateBot).toHaveBeenCalledWith('bot-a', { persona: '新人格', chattiness: 80 })
    expect(handler.handle({ cmd: 'bot.update', args: { id: 'bot-a', persona: 'p', apiKey: 'sk-x' } }))
      .toEqual({ ok: false, err: 'bad args' })
    expect(handler.handle({ cmd: 'bot.update', args: { id: 'bot-a', nope: 1 } }))
      .toEqual({ ok: false, err: 'bad args' })
    expect(handler.handle({ cmd: 'bot.update', args: { id: 'missing', persona: 'p' } }))
      .toEqual({ ok: false, err: 'not found' })
  })

  it('bot.switchRoom 写 R20 覆盖；写失败回滚房间', () => {
    const { deck, runtime, handler } = make()
    expect(handler.handle({ cmd: 'bot.switchRoom', args: { id: 'bot-a', room: 'amber' } }))
      .toEqual({ ok: true, err: null })
    expect(deck.switchBotRoom).toHaveBeenCalledWith('bot-a', 'amber')
    expect(runtime.setRoomOverride).toHaveBeenCalledWith('bot-a', { room: 'amber', baseRoom: 'nebula' })

    runtime.setRoomOverride.mockImplementation(() => { throw new Error('EIO') })
    expect(handler.handle({ cmd: 'bot.switchRoom', args: { id: 'bot-a', room: 'magenta' } }))
      .toEqual({ ok: false, err: 'runtime write failed' })
    expect(deck.bots[0].rt.roomId).toBe('amber') // 回滚到切换前
  })

  it('非法 id/room/未知 cmd/deck.update 拒绝；错误文本不回显参数', () => {
    const { handler } = make()
    expect(handler.handle({ cmd: 'nope', args: {} })).toEqual({ ok: false, err: 'unknown cmd' })
    expect(handler.handle({ cmd: 'deck.update', args: {} })).toEqual({ ok: false, err: 'unsupported' })
    expect(handler.handle({ cmd: 'bot.start', args: { id: '../x' } })).toEqual({ ok: false, err: 'bad args' })
    expect(handler.handle({ cmd: 'bot.switchRoom', args: { id: 'bot-a', room: 'AMBER!' } }))
      .toEqual({ ok: false, err: 'bad args' })
    expect(REMOTE_COMMANDS).toContain('bot.switchRoom')
  })
})

describe('buildDevState / keyHintOf', () => {
  it('keyHint 只暴露后 4 位；短 key 不回显', () => {
    expect(keyHintOf('sk-1234567890abcdef')).toBe('****cdef')
    expect(keyHintOf('short')).toBe(null)
    expect(keyHintOf(null)).toBe(null)
  })

  it('state 投影不含 apiKey，只带 keyHint 与 bot 运行态', () => {
    const { deck } = make()
    const snapshot = {
      meta: { generatedAt: 123 },
      bots: deck.bots.map((b) => ({
        id: b.id, name: b.name, room: b.rt.roomId, status: b.rt.status,
        nick: b.rt.nick, hourCount: b.rt.hourCount, session: b.rt.session,
        lifetime: { promptTokens: 10, completionTokens: 20 },
      })),
    }
    const state = buildDevState({
      snapshot,
      provider: { id: 'daemon', name: 'daemon', baseUrl: 'https://api.example/v1', apiKey: 'sk-1234567890abcdef' },
    })
    expect(JSON.stringify(state)).not.toContain('sk-1234567890abcdef')
    expect(state.providers[0].keyHint).toBe('****cdef')
    expect(state.bots[0]).toMatchObject({ id: 'bot-a', room: 'nebula', status: 'open' })
    expect(state.at).toBe(123)
  })
})
