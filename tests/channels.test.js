import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHANNELS,
  pickChannel,
  reshuffleChannel,
  codename,
  PUBLIC_ROOM_IDS,
  channelByRoomId,
} from '../src/theme/channels'

describe('channels', () => {
  beforeEach(() => sessionStorage.clear())

  it('exposes 4 channels with required fields', () => {
    expect(CHANNELS).toHaveLength(4)
    for (const c of CHANNELS) {
      expect(c).toHaveProperty('freq')
      expect(c).toHaveProperty('prefix')
      expect(c).toHaveProperty('color')
      expect(c).toHaveProperty('glow')
    }
  })

  it('pickChannel returns a channel from CHANNELS', () => {
    const c = pickChannel(() => 0.5)
    expect(CHANNELS).toContainEqual(c)
  })

  it('pickChannel persists to sessionStorage and returns same channel on second call', () => {
    const first = pickChannel(() => 0.5)
    const second = pickChannel(() => 0.99) // rng 被忽略，因 storage 命中
    expect(second).toEqual(first)
  })

  it('reshuffleChannel returns a channel and updates storage', () => {
    const c = reshuffleChannel(() => 0.1)
    expect(CHANNELS).toContainEqual(c)
    expect(sessionStorage.getItem('kuoluosaigai:channel')).toBe(c.freq)
  })

  it('codename formats as PREFIX-FREQ', () => {
    expect(codename(CHANNELS[0])).toBe(`${CHANNELS[0].prefix}-${CHANNELS[0].freq}`)
  })

  it('每项含 roomId 且等于 prefix 小写', () => {
    for (const c of CHANNELS) {
      expect(c).toHaveProperty('roomId')
      expect(c.roomId).toBe(c.prefix.toLowerCase())
    }
  })

  it('PUBLIC_ROOM_IDS 恰为四公共房（与 server/rooms.js 字面量镜像）', () => {
    expect(PUBLIC_ROOM_IDS).toEqual(['setsubun', 'nebula', 'magenta', 'amber'])
  })

  it('channelByRoomId 命中返回对应频道（magenta → MAGENTA 前缀项而非 AMBER），未知返回 null', () => {
    const c = channelByRoomId('magenta')
    expect(c).toEqual(CHANNELS[2])
    expect(c.prefix).toBe('MAGENTA')
    expect(channelByRoomId('nope')).toBeNull()
    expect(channelByRoomId(null)).toBeNull()
  })
})
