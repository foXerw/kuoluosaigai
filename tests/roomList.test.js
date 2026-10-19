import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadRooms,
  addRoom,
  removeRoom,
  __resetFallbackForTest,
} from '../src/chat/roomList'
import { PUBLIC_ROOM_IDS } from '../src/theme/channels'

const KEY = 'kuoluosaigai:rooms'

// fake storage：最小接口，store 直接可查（断言落盘内容用）
function fakeStorage(initial = {}) {
  const store = { ...initial }
  return {
    store,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null
    },
    setItem(k, v) {
      store[k] = String(v)
    },
  }
}

// 隐私模式：读写全抛异常的 storage
function throwingStorage() {
  return {
    getItem() {
      throw new Error('SecurityError: privacy mode')
    },
    setItem() {
      throw new Error('SecurityError: privacy mode')
    },
  }
}

function storedIds(s) {
  return JSON.parse(s.store[KEY])
}

describe('roomList', () => {
  // 模块级兜底数组是跨调用状态，逐例重置保证隔离
  beforeEach(() => __resetFallbackForTest())

  it('loadRooms：空存储 → 恰为 PUBLIC_ROOM_IDS', () => {
    const s = fakeStorage()
    expect(loadRooms(s)).toEqual(PUBLIC_ROOM_IDS)
  })

  it('loadRooms：公共恒在前 + 去重（存了 ["abc123","nebula"]）', () => {
    const s = fakeStorage({ [KEY]: JSON.stringify(['abc123', 'nebula']) })
    expect(loadRooms(s)).toEqual(['setsubun', 'nebula', 'magenta', 'amber', 'abc123'])
  })

  it('loadRooms：过滤非字符串/空串垃圾、去内部重复，坏 JSON 视作空', () => {
    const s = fakeStorage({
      [KEY]: JSON.stringify([null, 42, '', {}, 'abc123', 'abc123']),
    })
    expect(loadRooms(s)).toEqual([...PUBLIC_ROOM_IDS, 'abc123'])
    const broken = fakeStorage({ [KEY]: '{not json' })
    expect(loadRooms(broken)).toEqual(PUBLIC_ROOM_IDS)
    const notArray = fakeStorage({ [KEY]: JSON.stringify({ a: 1 }) })
    expect(loadRooms(notArray)).toEqual(PUBLIC_ROOM_IDS)
  })

  it('addRoom：落盘含新 id；重复 add 幂等（只出现一次）', () => {
    const s = fakeStorage()
    const after = addRoom('abc123', s)
    expect(after).toEqual([...PUBLIC_ROOM_IDS, 'abc123'])
    expect(storedIds(s)).toContain('abc123')
    const again = addRoom('abc123', s)
    expect(again).toEqual(after)
    expect(storedIds(s).filter((x) => x === 'abc123')).toHaveLength(1)
  })

  it('removeRoom：公共 id 拒绝移除、原样返回；私有 id 删除并落盘', () => {
    const s = fakeStorage()
    addRoom('abc123', s)
    const refused = removeRoom('nebula', s)
    expect(refused).toEqual([...PUBLIC_ROOM_IDS, 'abc123'])
    expect(storedIds(s)).toContain('nebula') // 未被改动
    const removed = removeRoom('abc123', s)
    expect(removed).toEqual(PUBLIC_ROOM_IDS)
    expect(storedIds(s)).not.toContain('abc123')
  })

  it('读写全抛错的 storage：三函数不 throw，会话内列表仍可增删', () => {
    const s = throwingStorage()
    expect(loadRooms(s)).toEqual(PUBLIC_ROOM_IDS)
    expect(addRoom('priv1', s)).toEqual([...PUBLIC_ROOM_IDS, 'priv1'])
    expect(addRoom('priv1', s)).toEqual([...PUBLIC_ROOM_IDS, 'priv1']) // 幂等
    expect(loadRooms(s)).toEqual([...PUBLIC_ROOM_IDS, 'priv1'])
    expect(removeRoom('priv1', s)).toEqual(PUBLIC_ROOM_IDS)
    expect(removeRoom('setsubun', s)).toEqual(PUBLIC_ROOM_IDS)
    expect(loadRooms(s)).toEqual(PUBLIC_ROOM_IDS)
  })
})
