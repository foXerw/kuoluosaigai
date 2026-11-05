import { describe, it, expect } from 'vitest'
import { applyRoomOverrides } from '../host.js'

function fakeDeck(roomId = 'nebula') {
  const item = { id: 'bot-a', roomId, rt: { roomId } }
  return {
    bots: [item],
    switchLog: [],
    switchBotRoom(id, room) {
      this.switchLog.push([id, room])
      item.roomId = room
      item.rt.roomId = room
      return true
    },
  }
}

function fakeRuntime(override = null) {
  return {
    cleared: [],
    getRoomOverride() { return override },
    clearRoomOverride(id) { this.cleared.push(id) },
  }
}

describe('applyRoomOverrides（R20）', () => {
  it('配置房未变 → 应用覆盖房', () => {
    const deck = fakeDeck('nebula')
    const runtime = fakeRuntime({ room: 'amber', baseRoom: 'nebula' })
    const res = applyRoomOverrides({ deck, runtime, bots: [{ id: 'bot-a', room: 'nebula' }] })
    expect(res).toEqual({ applied: ['bot-a'], cleared: [], errors: [] })
    expect(deck.switchLog).toEqual([['bot-a', 'amber']])
    expect(deck.bots[0].rt.roomId).toBe('amber')
  })

  it('配置房已变 → 清覆盖、配置赢', () => {
    const deck = fakeDeck('magenta')
    const runtime = fakeRuntime({ room: 'amber', baseRoom: 'nebula' })
    const res = applyRoomOverrides({ deck, runtime, bots: [{ id: 'bot-a', room: 'magenta' }] })
    expect(res).toEqual({ applied: [], cleared: ['bot-a'], errors: [] })
    expect(runtime.cleared).toEqual(['bot-a'])
    expect(deck.switchLog).toEqual([])
    expect(deck.bots[0].rt.roomId).toBe('magenta')
  })

  it('已在覆盖房 → 不重复切换', () => {
    const deck = fakeDeck('amber')
    const runtime = fakeRuntime({ room: 'amber', baseRoom: 'nebula' })
    expect(applyRoomOverrides({ deck, runtime, bots: [{ id: 'bot-a', room: 'nebula' }] })).toEqual({
      applied: [],
      cleared: [],
      errors: [],
    })
    expect(deck.switchLog).toEqual([])
  })

  it('runtime 读/清抛错 → 记录 errors、按配置房继续，不抛', () => {
    const deck = fakeDeck('nebula')
    const throwing = {
      getRoomOverride() { throw new Error('EIO') },
      clearRoomOverride() { throw new Error('EIO') },
    }
    expect(applyRoomOverrides({ deck, runtime: throwing, bots: [{ id: 'bot-a', room: 'nebula' }] }))
      .toEqual({ applied: [], cleared: [], errors: ['bot-a'] })
    expect(deck.switchLog).toEqual([])
    expect(deck.bots[0].rt.roomId).toBe('nebula')
  })

  it('无覆盖 / deck 里没有该 bot / runtime 缺失 → 安全空操作', () => {
    const deck = fakeDeck('nebula')
    expect(applyRoomOverrides({ deck, runtime: fakeRuntime(null), bots: [{ id: 'bot-a', room: 'nebula' }] })).toEqual({ applied: [], cleared: [], errors: [] })
    expect(applyRoomOverrides({ deck, runtime: fakeRuntime({ room: 'amber', baseRoom: 'nebula' }), bots: [{ id: 'gone', room: 'nebula' }] })).toEqual({ applied: [], cleared: [], errors: [] })
    expect(applyRoomOverrides({ deck, runtime: null, bots: [{ id: 'bot-a', room: 'nebula' }] })).toEqual({ applied: [], cleared: [], errors: [] })
    expect(deck.switchLog).toEqual([])
  })
})
