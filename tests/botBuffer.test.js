import { describe, it, expect } from 'vitest'
import { createContextBuffer } from '../src/bots/buffer'

// 消息帧形状（与服务器 message 帧一致）：{ id, ts, roomId, nick, badge, text }
// ContextBuffer 将帧视为不透明对象原样存储，不做深拷贝。
// B18：本模块不 import roomCache，职责边界独立——buffer 供观战窗 + LLM 上下文数据源，
//       roomCache 是客户端房间缓存；两者返回语义刻意不同（见 below）。
const msg = (id, ts, text = 'hi') => ({
  type: 'message',
  id,
  ts,
  roomId: 'r1',
  nick: 'ANON-AAAA',
  badge: '',
  text,
})

describe('createContextBuffer', () => {
  it('push 超过 max=200 丢最旧保留最新', () => {
    const b = createContextBuffer()
    for (let i = 0; i < 250; i++) b.push(msg(i, i))
    expect(b.size).toBe(200)
    expect(b.all()[0].id).toBe(50)
    expect(b.all()[199].id).toBe(249)
  })

  it('recent(40) 返回末尾 40 条新数组，引用 !== all()', () => {
    const b = createContextBuffer()
    for (let i = 0; i < 60; i++) b.push(msg(i, i))
    const recent = b.recent(40)
    expect(recent.length).toBe(40)
    expect(recent[0].id).toBe(20)
    expect(recent[39].id).toBe(59)
    expect(recent).not.toBe(b.all()) // 引用不同
    expect(Array.isArray(recent)).toBe(true)
  })

  it('不足 n 条时 recent 返回全量', () => {
    const b = createContextBuffer()
    for (let i = 0; i < 10; i++) b.push(msg(i, i))
    const recent = b.recent(40)
    expect(recent.length).toBe(10)
    expect(recent[0].id).toBe(0)
    expect(recent[9].id).toBe(9)
  })

  it('replace 截到 max，clear 归零', () => {
    const b = createContextBuffer()
    for (let i = 0; i < 250; i++) b.push(msg(i, i))
    b.replace(Array.from({ length: 300 }, (_, i) => msg(i, i)))
    expect(b.size).toBe(200)
    expect(b.all()[0].id).toBe(100)
    expect(b.all()[199].id).toBe(299)
    b.clear()
    expect(b.size).toBe(0)
    expect(b.all()).toEqual([])
    expect(b.recent()).toEqual([])
  })

  it('all 返回副本，外部 push 不影响内部', () => {
    const b = createContextBuffer()
    b.push(msg(1, 1))
    const copy = b.all()
    copy.push(msg(99, 99))
    expect(b.size).toBe(1)
    expect(copy.length).toBe(2)
  })

  it('default max=200', () => {
    const b = createContextBuffer()
    expect(b.size).toBe(0)
    b.push(msg(1, 1))
    expect(b.size).toBe(1)
  })

  it('custom max', () => {
    const b = createContextBuffer({ max: 5 })
    for (let i = 0; i < 8; i++) b.push(msg(i, i))
    expect(b.size).toBe(5)
    expect(b.all()[0].id).toBe(3)
    expect(b.all()[4].id).toBe(7)
  })

  it('recent() 无参默认 40', () => {
    const b = createContextBuffer()
    for (let i = 0; i < 100; i++) b.push(msg(i, i))
    const r = b.recent()
    expect(r.length).toBe(40)
    expect(r[0].id).toBe(60)
    expect(r[39].id).toBe(99)
  })

  it('replace 空数组清空', () => {
    const b = createContextBuffer()
    b.push(msg(1, 1))
    b.replace([])
    expect(b.size).toBe(0)
  })
})
