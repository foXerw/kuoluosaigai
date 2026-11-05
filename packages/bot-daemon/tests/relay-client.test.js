import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRelayClient } from '../relay-client.js'

const T1 = 'a'.repeat(64)
const T2 = 'b'.repeat(64)

class StubSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closed = null
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    StubSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; if (this.onopen) this.onopen() }
  emit(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }) }
  close() { this.readyState = 3; this.closed = true }
}
StubSocket.instances = []

function make(extra = {}) {
  const statuses = []
  const pairedEvents = []
  const logs = []
  const client = createRelayClient({
    url: 'wss://chat.example',
    token: T1,
    name: 'lab-vm',
    WebSocketImpl: StubSocket,
    onStatus: (s) => statuses.push(s),
    onPaired: (f) => pairedEvents.push(f),
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    ...extra,
  })
  return { client, statuses, pairedEvents, logs }
}

const last = (s) => s.sent[s.sent.length - 1]
const socket = () => StubSocket.instances[StubSocket.instances.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  StubSocket.instances = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createRelayClient', () => {
  it('连接 /device 并发 dev-auth；auth-ok 后状态 open', () => {
    const { client, statuses } = make()
    client.start()
    const s = socket()
    expect(s.url).toBe('wss://chat.example/device')
    s.open()
    expect(last(s)).toEqual({ t: 'dev-auth', role: 'daemon', token: T1, name: 'lab-vm', ver: 'p3b' })
    s.emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'dddddddddddddddd', name: 'lab-vm', paired: false })
    expect(client.status()).toBe('open')
    expect(client.paired()).toBe(false)
    expect(statuses).toContain('open')
    client.stop()
  })

  it('requestPair 发送 pair-new 并解析 pair-code；paired 事件触发', async () => {
    const { client, pairedEvents } = make()
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'lab-vm', paired: false })

    const p = client.requestPair()
    expect(last(socket())).toEqual({ t: 'pair-new' })
    socket().emit({ t: 'pair-code', code: 'ABC234', expiresMs: 60000 })
    await expect(p).resolves.toEqual({ code: 'ABC234', expiresMs: 60000 })

    socket().emit({ t: 'paired', deviceId: 'd', sessionId: 's' })
    expect(client.paired()).toBe(true)
    expect(pairedEvents).toHaveLength(1)
    client.stop()
  })

  it('dev-cmd 交给 handler 并回 dev-res；handler 抛错回 internal', async () => {
    let shouldThrow = false
    const { client } = make({
      onCommand: () => {
        if (shouldThrow) throw new Error('boom')
        return { ok: true }
      },
    })
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'n' })
    socket().emit({ t: 'paired', deviceId: 'd' })
    socket().emit({ t: 'dev-cmd', from: 's', id: 'c1', cmd: 'deck.get', args: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(last(socket())).toEqual({ t: 'dev-res', id: 'c1', ok: true, err: null })

    shouldThrow = true
    socket().emit({ t: 'dev-cmd', from: 's', id: 'c2', cmd: 'bot.start', args: { id: 'x' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(last(socket())).toEqual({ t: 'dev-res', id: 'c2', ok: false, err: 'internal' })
    client.stop()
  })

  it('pushState 只在已配对时发送', () => {
    const { client } = make()
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'n', paired: false })
    expect(client.pushState({ a: 1 })).toBe(false)
    socket().emit({ t: 'paired', deviceId: 'd' })
    expect(client.pushState({ a: 1 })).toBe(true)
    expect(last(socket())).toEqual({ t: 'dev-state', state: { a: 1 } })
    client.stop()
  })

  it('rotate 发送 dev-revoke-all，ack 后换 token；拒绝时保持旧 token', async () => {
    const { client } = make()
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'n', paired: true })

    const p = client.rotate(T2)
    expect(last(socket())).toEqual({ t: 'dev-revoke-all', newToken: T2 })
    socket().emit({ t: 'dev-revoke-ok', deviceId: 'd2' })
    await expect(p).resolves.toEqual({ deviceId: 'd2' })
    expect(client.currentToken()).toBe(T2)

    const q = client.rotate(T1)
    socket().emit({ t: 'dev-revoke-err' })
    await expect(q).rejects.toThrow(/revoke/i)
    expect(client.currentToken()).toBe(T2)
    client.stop()
  })

  it('dev-replaced 停止重连', async () => {
    const { client, statuses } = make()
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'n' })
    socket().emit({ t: 'dev-replaced' })
    expect(client.status()).toBe('replaced')
    expect(client.isOpen()).toBe(false)

    await vi.advanceTimersByTimeAsync(10000)
    expect(StubSocket.instances).toHaveLength(1) // 没有新连接
    expect(statuses).toContain('replaced')
  })

  it('断线按退避重连；stop 清定时器', async () => {
    const { client } = make()
    client.start()
    socket().open()
    socket().emit({ t: 'dev-auth-ok', role: 'daemon', deviceId: 'd', name: 'n' })
    socket().onclose({ code: 1006 })
    expect(client.status()).toBe('closed')

    await vi.advanceTimersByTimeAsync(1000)
    expect(StubSocket.instances).toHaveLength(2)
    client.stop()
    socket().onclose({ code: 1006 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(StubSocket.instances).toHaveLength(2)
  })

  it('dev-auth-err 为致命：停止并不再重连', async () => {
    const { client, statuses } = make()
    client.start(); socket().open()
    socket().emit({ t: 'dev-auth-err' })
    expect(client.status()).toBe('error')
    await vi.advanceTimersByTimeAsync(10000)
    expect(StubSocket.instances).toHaveLength(1)
    expect(statuses).toContain('error')
  })
})
