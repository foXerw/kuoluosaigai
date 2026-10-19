import { describe, it, expect } from 'vitest'
import { createRoomCache } from '../src/chat/roomCache'

// 消息帧形状（Task 2/3 合同）：{ id, ts, roomId, nick, badge, text }
// 本缓存把帧视为不透明对象，原样存引用，不做深拷贝、不修改帧内容。
function msg(id, ts, roomId = 'r1') {
  return { id, ts, roomId, nick: 'NICK', badge: 'SETSUBUN', text: `text-${id}` }
}

function ids(list) {
  return list.map((m) => m.id)
}

describe('createRoomCache', () => {
  it('append 后 get 含该条；未知房间 get 返回 []', () => {
    const cache = createRoomCache()
    expect(cache.get('nope')).toEqual([])
    cache.append('r1', msg('a', 1))
    cache.append('r1', msg('b', 2))
    expect(ids(cache.get('r1'))).toEqual(['a', 'b'])
  })

  it('replace 覆盖旧内容', () => {
    const cache = createRoomCache()
    cache.append('r1', msg('old', 1))
    cache.replace('r1', [msg('n1', 10), msg('n2', 20)])
    expect(ids(cache.get('r1'))).toEqual(['n1', 'n2'])
  })

  it('每房上限：maxPerRoom=3，append 5 条 → 只剩最后 3（丢最旧）', () => {
    const cache = createRoomCache({ maxPerRoom: 3 })
    for (let i = 1; i <= 5; i++) cache.append('r1', msg(`m${i}`, i))
    expect(ids(cache.get('r1'))).toEqual(['m3', 'm4', 'm5'])
  })

  it('replace 也受每房上限：超限丢最旧', () => {
    const cache = createRoomCache({ maxPerRoom: 3 })
    cache.replace('r1', [msg('m1', 1), msg('m2', 2), msg('m3', 3), msg('m4', 4), msg('m5', 5)])
    expect(ids(cache.get('r1'))).toEqual(['m3', 'm4', 'm5'])
  })

  it('LRU：maxRooms=2 → 建 r1,r2，touch r1，append r3 → r2 被逐，r1、r3 在（Review Focus #3）', () => {
    const cache = createRoomCache({ maxRooms: 2 })
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2'))
    cache.touch('r1') // r1 变为 MRU，r2 成为 LRU
    cache.append('r3', msg('c', 3, 'r3')) // 新建 r3 超限 → 逐 LRU（r2）
    expect(cache.get('r2')).toEqual([])
    expect(ids(cache.get('r1'))).toEqual(['a'])
    expect(ids(cache.get('r3'))).toEqual(['c'])
  })

  it('新建房间本身（刚被操作 = MRU）永不成为被逐者', () => {
    const cache = createRoomCache({ maxRooms: 1 })
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2')) // 新建 r2 超限，victim 是 r1 而非 r2
    expect(cache.get('r2')).toHaveLength(1)
    expect(cache.get('r1')).toEqual([])
  })

  it('replace 新建房间超 maxRooms 同样触发 LRU 逐出', () => {
    const cache = createRoomCache({ maxRooms: 2 })
    cache.replace('r1', [msg('a', 1, 'r1')])
    cache.replace('r2', [msg('b', 2, 'r2')])
    cache.touch('r1') // r2 成为 LRU
    cache.replace('r3', [msg('c', 3, 'r3')]) // 新建 r3 超限 → 逐 r2
    expect(cache.get('r2')).toEqual([])
    expect(cache.get('r1')).toHaveLength(1)
    expect(cache.get('r3')).toHaveLength(1)
  })

  it('get 也刷新 MRU：maxRooms=2，建 r1,r2，get r1，append r3 → r2 被逐', () => {
    const cache = createRoomCache({ maxRooms: 2 })
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2'))
    cache.get('r1')
    cache.append('r3', msg('c', 3, 'r3'))
    expect(cache.get('r2')).toEqual([])
    expect(ids(cache.get('r1'))).toEqual(['a'])
    expect(ids(cache.get('r3'))).toEqual(['c'])
  })

  it('append 已有房间不新建、不逐出', () => {
    const cache = createRoomCache({ maxRooms: 2 })
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2'))
    cache.append('r1', msg('a2', 3, 'r1')) // r1 已存在 → 房间数不超，无逐出
    expect(cache.get('r1')).toHaveLength(2)
    expect(cache.get('r2')).toHaveLength(1)
  })

  it('drop 只删指定房', () => {
    const cache = createRoomCache()
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2'))
    cache.drop('r1')
    expect(cache.get('r1')).toEqual([])
    expect(ids(cache.get('r2'))).toEqual(['b'])
  })

  it('drop/touch 未知房间是 no-op，不会凭空建房间', () => {
    const cache = createRoomCache({ maxRooms: 2 })
    cache.append('r1', msg('a', 1, 'r1'))
    cache.append('r2', msg('b', 2, 'r2'))
    cache.touch('r1') // r1 换到 MRU，r2 成为合法的 LRU victim
    cache.drop('ghost') // 未知房 drop：必须无痕迹
    cache.touch('ghost') // 未知房 touch：若实现建档，幽灵会占坑连环挤出 r1（下方 get(r1) 即歼灭性断言）
    cache.append('r3', msg('c', 3, 'r3'))
    expect(cache.get('r2')).toEqual([]) // 正确行为：只逐合法 LRU（r2）
    expect(cache.get('r1')).toHaveLength(1) // 幽灵若建档会挤掉 r1 —— 判别点
    expect(cache.get('r3')).toHaveLength(1)
  })

  it('引用语义：不做深拷贝——帧对象原样存储；append 后再次 get 可见（内部一致）', () => {
    const cache = createRoomCache()
    const m = msg('a', 1)
    cache.append('r1', m)
    expect(cache.get('r1')[0]).toBe(m) // 同一帧引用
    const before = cache.get('r1')
    cache.append('r1', msg('b', 2))
    expect(ids(cache.get('r1'))).toEqual(['a', 'b']) // 再取得到新条目
    expect(before).toBe(cache.get('r1')) // 同数组引用实现亦合规（写明不深拷贝）
  })

  it('默认参数：maxRooms=20 —— 第 21 个新房间逐出 LRU', () => {
    const cache = createRoomCache()
    for (let i = 1; i <= 20; i++) cache.append(`r${i}`, msg(`m${i}`, i, `r${i}`))
    cache.append('r21', msg('m21', 21, 'r21'))
    expect(cache.get('r1')).toEqual([])
    expect(cache.get('r2')).toHaveLength(1)
    expect(cache.get('r21')).toHaveLength(1)
  })

  it('默认每房上限 500 不截断小规模 append', () => {
    const cache = createRoomCache()
    for (let i = 1; i <= 10; i++) cache.append('r1', msg(`m${i}`, i))
    expect(cache.get('r1')).toHaveLength(10)
  })
})
