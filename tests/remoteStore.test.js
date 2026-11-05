import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRemoteStore, DEVICES_KEY } from '../src/bots/remote.js'

class MapStorage {
  #m = new Map()
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null }
  setItem(k, v) { this.#m.set(k, String(v)) }
  removeItem(k) { this.#m.delete(k) }
}

class StubSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    StubSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; if (this.onopen) this.onopen() }
  emit(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }) }
  close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }) }
}
StubSocket.instances = []

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const socket = () => StubSocket.instances[StubSocket.instances.length - 1]
const last = (s) => s.sent[s.sent.length - 1]

const okPair = (over = {}) => ({
  t: 'pair-ok', deviceId: 'dev1', name: 'lab-vm',
  token: 'e'.repeat(64), sessionId: 'a'.repeat(16), ...over,
})

function make(opts = {}) {
  const storage = opts.storage || new MapStorage()
  const store = createRemoteStore({
    wsUrl: 'wss://chat.example',
    storage,
    WebSocketImpl: StubSocket,
    now: () => 1000,
    commandTimeoutMs: 5000,
    ...opts,
  })
  return { store, storage }
}

async function pairAndConnect(store) {
  const p = store.pair('ABC234', 'Phone')
  const s1 = socket()
  s1.open()
  await flush()
  expect(last(s1)).toEqual({ t: 'pair-claim', code: 'ABC234', label: 'Phone' })
  s1.emit(okPair())
  await expect(p).resolves.toMatchObject({ deviceId: 'dev1', name: 'lab-vm' })
  await flush()

  const s2 = socket()
  s2.open()
  await flush()
  expect(last(s2)).toEqual({
    t: 'dev-auth', role: 'browser', deviceId: 'dev1',
    token: 'e'.repeat(64), sessionId: 'a'.repeat(16),
  })
  s2.emit({ t: 'dev-auth-ok', role: 'browser', deviceId: 'dev1', name: 'lab-vm', paired: true, online: true })
  return s2
}

beforeEach(() => {
  vi.useFakeTimers()
  StubSocket.instances = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createRemoteStore', () => {
  it('pair：claim 成功写 roster、选设备并重新 auth', async () => {
    const { store, storage } = make()
    const s = await pairAndConnect(store)
    expect(store.devices).toHaveLength(1)
    expect(store.selectedId).toBe('dev1')
    expect(store.status).toBe('open')
    expect(store.online).toBe(true)
    const doc = JSON.parse(storage.getItem(DEVICES_KEY))
    expect(doc.devices[0]).toMatchObject({ deviceId: 'dev1', name: 'lab-vm' })
    expect(doc.devices[0].token).toBe('e'.repeat(64))
    expect(s).toBeTruthy()
  })

  it('roster 持久化并重载；配对失败给固定错误', async () => {
    const storage = new MapStorage()
    storage.setItem(DEVICES_KEY, JSON.stringify({
      version: 1,
      devices: [{ deviceId: 'd', name: 'n', token: 'f'.repeat(64), sessionId: 'b'.repeat(16) }],
    }))
    const { store } = make({ storage })
    expect(store.devices).toHaveLength(1)
    expect(store.devices[0].deviceId).toBe('d')

    const p = store.pair('ZZZZZZ')
    socket().open(); await flush()
    socket().emit({ t: 'pair-error' })
    await expect(p).rejects.toThrow(/pair/i)
  })

  it('dev-state 映射 bots/providers；online/offline 跟随帧', async () => {
    const { store } = make()
    const s = await pairAndConnect(store)
    s.emit({
      t: 'dev-state',
      state: {
        bots: [{ id: 'b1', name: '小李', room: 'nebula', status: 'open', nick: 'ANON-A', hourCount: 2, session: { messages: 3 }, lifetime: {} }],
        providers: [{ id: 'daemon', name: 'daemon', baseUrl: 'https://api', keyHint: '****cdef' }],
      },
    })
    expect(store.bots[0]).toMatchObject({ id: 'b1', name: '小李', room: 'nebula' })
    expect(store.providers[0].keyHint).toBe('****cdef')
    s.emit({ t: 'dev-offline', deviceId: 'dev1' })
    expect(store.online).toBe(false)
    s.emit({ t: 'dev-online', deviceId: 'dev1' })
    expect(store.online).toBe(true)
  })

  it('command → dev-cmd(to/id) → dev-res resolve；未连接拒绝', async () => {
    const { store } = make()
    await expect(store.command('bot.start', { id: 'b1' })).rejects.toThrow(/not connected/)
    const s = await pairAndConnect(store)
    const p = store.command('bot.start', { id: 'b1' })
    const frame = last(s)
    expect(frame).toMatchObject({ t: 'dev-cmd', to: 'dev1', cmd: 'bot.start', args: { id: 'b1' } })
    s.emit({ t: 'dev-res', id: frame.id, ok: true, err: null })
    await expect(p).resolves.toEqual({ ok: true, err: null })
  })

  it('命令回执失败 resolve {ok:false}；超时 reject', async () => {
    const { store } = make()
    const s = await pairAndConnect(store)
    const p = store.command('bot.stop', { id: 'x' })
    s.emit({ t: 'dev-res', id: last(s).id, ok: false, err: 'not found' })
    await expect(p).resolves.toEqual({ ok: false, err: 'not found' })

    const q = store.command('bot.stop', { id: 'x' })
    const rejection = expect(q).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(5000)
    await rejection
  })

  it('sessions 列表与单会话撤销', async () => {
    const { store } = make()
    const s = await pairAndConnect(store)
    const p = store.refreshSessions()
    expect(last(s).t).toBe('dev-sessions')
    s.emit({ t: 'dev-sessions-res', id: last(s).id, sessions: [{ sessionId: 'a', label: 'Phone', createdAt: 1, online: true }] })
    await expect(p).resolves.toHaveLength(1)
    expect(store.sessions[0].label).toBe('Phone')

    const q = store.revokeSession('a')
    expect(last(s)).toMatchObject({ t: 'dev-session-revoke', sessionId: 'a' })
    s.emit({ t: 'dev-res', id: last(s).id, ok: true, err: null })
    await expect(q).resolves.toEqual({ ok: true, err: null })
  })

  it('dev-revoked：下线、清 roster、拒绝后续命令', async () => {
    const { store, storage } = make()
    const s = await pairAndConnect(store)
    s.emit({ t: 'dev-revoked' })
    expect(store.status).toBe('error')
    expect(store.online).toBe(false)
    expect(store.devices).toHaveLength(0)
    expect(JSON.parse(storage.getItem(DEVICES_KEY)).devices).toEqual([])
    await expect(store.command('bot.start', { id: 'b1' })).rejects.toThrow(/not connected/)
  })

  it('disconnect 清状态与待回执；removeDevice 清 roster', async () => {
    const { store } = make()
    await pairAndConnect(store)
    const pending = store.command('bot.start', { id: 'b1' })
    const rejection = expect(pending).rejects.toThrow(/disconnected/)
    store.disconnect()
    await rejection
    expect(store.status).toBe('closed')
    expect(store.online).toBe(false)
    store.removeDevice('dev1')
    expect(store.devices).toHaveLength(0)
    expect(store.selectedId).toBe(null)
  })
})
