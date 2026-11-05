import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileStateStore } from '../state.js'
import { createDaemonHost } from '../host.js'

const T1 = 'a'.repeat(64)
const T2 = 'b'.repeat(64)
const ID1 = '1111111111111111'
const ID2 = '2222222222222222'

const cfg = {
  name: 'lab-vm',
  serverUrl: 'wss://chat.example',
  provider: { baseUrl: 'https://api.example/v1', apiKey: 'sk-1234567890abcdef', model: 'm' },
  bots: [{ id: 'lixiao', name: '小李', persona: 'p', room: 'nebula', chattiness: 50, temperature: 0.9 }],
}

function fakeRunner() {
  return {
    start() {}, stop() {}, switchRoom() {}, clearBuffer() {},
    getBuffer() { return [] }, idleEligible() { return false }, idleRoll() { return false }, pokeIdle() {},
  }
}

let dir
let host
let link
let captured
let identity

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-host-p3b-'))
  captured = null
  link = {
    start: vi.fn(),
    stop: vi.fn(),
    pushState: vi.fn(() => true),
    paired: vi.fn(() => false),
    status: vi.fn(() => 'open'),
    requestPair: vi.fn(async () => ({ code: 'ABC234', expiresMs: 60000 })),
    rotate: vi.fn(async () => ({ deviceId: ID2 })),
    setToken: vi.fn(),
  }
  identity = {
    token: vi.fn(() => T1),
    deviceId: vi.fn(() => ID1),
    rotate: vi.fn(() => ({ token: T2, deviceId: ID2 })),
    setToken: vi.fn(),
  }
})

afterEach(() => {
  if (host) host.shutdown()
  host = null
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeHost(extra = {}) {
  const store = createFileStateStore({ dir })
  host = createDaemonHost({
    cfg,
    store,
    logger: { info() {}, warn() {}, error() {} },
    WebSocketImpl: function NoWS() { throw new Error('no real ws') },
    sleep: async () => {},
    createRunner: () => fakeRunner(),
    createIdentity: () => identity,
    createLink: (o) => { captured = o; return link },
    statePushMs: 1e9,
    ...extra,
  })
  return { host, store }
}

describe('host P3b 设备链路', () => {
  it('boot：meta.deviceId 派生、link 用 token/name/url 启动', async () => {
    makeHost()
    await host.boot()
    expect(host.snapshot().meta.deviceId).toBe(ID1)
    expect(host.snapshot().meta.paired).toBe(false)
    expect(link.start).toHaveBeenCalledTimes(1)
    expect(captured).toMatchObject({ url: 'wss://chat.example', token: T1, name: 'lab-vm' })
  })

  it('paired 后推送 dev-state：含 keyHint、不含完整 key', async () => {
    makeHost()
    await host.boot()
    link.paired.mockReturnValue(true)
    captured.onPaired({ deviceId: ID1 })
    expect(link.pushState).toHaveBeenCalled()
    const state = link.pushState.mock.calls[0][0]
    expect(JSON.stringify(state)).not.toContain('sk-1234567890abcdef')
    expect(state.providers[0].keyHint).toBe('****cdef')
    expect(state.bots[0]).toMatchObject({ id: 'lixiao', room: 'nebula' })
  })

  it('pair 透传 requestPair；revoke 成功先落新 token 再发帧', async () => {
    makeHost()
    await host.boot()
    await expect(host.pair()).resolves.toEqual({ code: 'ABC234', expiresMs: 60000 })
    expect(link.requestPair).toHaveBeenCalledTimes(1)

    await expect(host.revokeAll()).resolves.toEqual({ deviceId: ID2 })
    expect(identity.rotate).toHaveBeenCalledTimes(1)
    expect(link.setToken).toHaveBeenCalledWith(T2)
    expect(link.rotate).toHaveBeenCalledWith(T2)
    expect(identity.setToken).not.toHaveBeenCalled()
  })

  it('revoke 失败：本地 token 回滚，不留下服务端/本地分叉', async () => {
    makeHost()
    await host.boot()
    link.rotate.mockRejectedValueOnce(new Error('revoke rejected'))
    await expect(host.revokeAll()).rejects.toThrow(/revoke/)
    expect(identity.setToken).toHaveBeenCalledWith(T1)
    expect(link.setToken).toHaveBeenLastCalledWith(T1)
  })

  it('shutdown 停 link', async () => {
    makeHost()
    await host.boot()
    host.shutdown()
    expect(link.stop).toHaveBeenCalledTimes(1)
    host = null
  })
})
