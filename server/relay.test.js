import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceStore, deriveDeviceId, hashToken } from './devices.js'
import { createRelay } from './relay.js'

const T1 = 'a'.repeat(64)
const T2 = 'b'.repeat(64)
const D1 = deriveDeviceId(T1)
const IP = '1.1.1.1'

let tmpDir
let store
let relay
let nowValue

function mkWs() {
  const ws = {
    sent: [],
    closed: null,
    send(frame) { this.sent.push(frame) },
    close(code, reason) { this.closed = { code, reason } },
  }
  return ws
}
const last = (ws) => ws.sent[ws.sent.length - 1]
const types = (ws) => ws.sent.map((f) => f.t)

function makeRelay(extra = {}) {
  nowValue = 0
  relay = createRelay({
    store,
    send: (ws, frame) => ws.send(frame),
    now: () => nowValue,
    ...extra,
  })
  return relay
}

function authDaemon(token = T1, name = 'lab-vm', ip = IP) {
  const ws = mkWs()
  relay.handle(ws, { t: 'dev-auth', role: 'daemon', token, name }, { ip })
  return ws
}

function makeCode(daemon) {
  relay.handle(daemon, { t: 'pair-new' }, { ip: IP })
  return last(daemon).code
}

function claim(code, label = 'Phone', ip = IP) {
  const ws = mkWs()
  relay.handle(ws, { t: 'pair-claim', code, label }, { ip })
  return ws
}

function authBrowser(token, sessionId, ip = '2.2.2.2') {
  const ws = mkWs()
  relay.handle(ws, { t: 'dev-auth', role: 'browser', token, sessionId }, { ip })
  return ws
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-relay-'))
  store = createDeviceStore({ file: path.join(tmpDir, 'devices.json') })
  makeRelay()
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('dev-auth', () => {
  it('未知 token 的 daemon → paired:false；已注册 → paired:true', () => {
    const a = authDaemon()
    expect(last(a)).toEqual({ t: 'dev-auth-ok', role: 'daemon', deviceId: D1, name: 'lab-vm', paired: false })

    store.upsert(D1, { tokenHash: hashToken(T1), name: '已注册', createdAt: 1, sessions: {} })
    const b = authDaemon()
    expect(last(b)).toEqual({ t: 'dev-auth-ok', role: 'daemon', deviceId: D1, name: '已注册', paired: true })
  })

  it('坏 token / 坏 role / 未认证帧 → 同一 dev-auth-err 或 unauthorized', () => {
    const a = mkWs()
    relay.handle(a, { t: 'dev-auth', role: 'daemon', token: 'nope' }, { ip: IP })
    expect(last(a)).toEqual({ t: 'dev-auth-err' })

    const b = mkWs()
    relay.handle(b, { t: 'dev-auth', role: 'root', token: T1 }, { ip: IP })
    expect(last(b)).toEqual({ t: 'dev-auth-err' })

    const c = mkWs()
    relay.handle(c, { t: 'dev-state', state: {} }, { ip: IP })
    expect(last(c)).toEqual({ t: 'error', msg: 'unauthorized' })
  })

  it('browser 必须 token + 已配对 session；错任一 → 同一 dev-auth-err', () => {
    const daemon = authDaemon()
    const code = makeCode(daemon)
    const browser = claim(code)
    const { sessionId } = last(browser)

    const ok = authBrowser(T1, sessionId)
    expect(last(ok)).toMatchObject({ t: 'dev-auth-ok', role: 'browser', deviceId: D1 })

    const badSession = authBrowser(T1, '0'.repeat(16))
    expect(last(badSession)).toEqual({ t: 'dev-auth-err' })
    const badToken = authBrowser(T2, sessionId)
    expect(last(badToken)).toEqual({ t: 'dev-auth-err' })
  })
})

describe('配对', () => {
  it('pair-new → 6 位码；claim → pair-ok 返回 token/session、落盘、daemon 收 paired', () => {
    const daemon = authDaemon()
    const code = makeCode(daemon)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(last(daemon)).toMatchObject({ t: 'pair-code', code, expiresMs: 60000 })

    const browser = claim(code)
    const ok = last(browser)
    expect(ok).toMatchObject({ t: 'pair-ok', deviceId: D1, name: 'lab-vm', token: T1 })
    expect(ok.sessionId).toMatch(/^[a-f0-9]{16}$/)
    expect(last(daemon)).toEqual({ t: 'paired', deviceId: D1, sessionId: ok.sessionId })

    const saved = store.get(D1)
    expect(saved.tokenHash).toBe(hashToken(T1))
    expect(saved.sessions[ok.sessionId].label).toBe('Phone')
  })

  it('同码二次 claim / 过期码 / 未知码 → 同一 pair-error', () => {
    const daemon = authDaemon()
    const code = makeCode(daemon)
    expect(types(claim(code))).toContain('pair-ok')
    expect(last(claim(code))).toEqual({ t: 'pair-error' })

    const code2 = makeCode(daemon)
    nowValue = 60001
    expect(last(claim(code2))).toEqual({ t: 'pair-error' })

    expect(last(claim('ZZZZZZ'))).toEqual({ t: 'pair-error' })
  })

  it('配对尝试 5 次/60s/IP；其他 IP 不受影响', () => {
    const daemon = authDaemon()
    const code = makeCode(daemon)
    for (let i = 0; i < 5; i++) claim('ZZZZZZ', 'x', '9.9.9.9')
    expect(last(claim(code, 'x', '9.9.9.9'))).toEqual({ t: 'pair-error' }) // 限速先于码校验
    expect(last(claim(code, 'x', '8.8.8.8'))).toMatchObject({ t: 'pair-ok' })
  })

  it('会话上限：第 11 个浏览器同一 pair-error', () => {
    makeRelay({ sessionCap: 2 })
    const daemon = authDaemon()
    expect(types(claim(makeCode(daemon)))).toContain('pair-ok')
    expect(types(claim(makeCode(daemon)))).toContain('pair-ok')
    expect(last(claim(makeCode(daemon)))).toEqual({ t: 'pair-error' })
  })

  it('未认证连接不能 pair-new', () => {
    const ws = mkWs()
    relay.handle(ws, { t: 'pair-new' }, { ip: IP })
    expect(last(ws)).toEqual({ t: 'error', msg: 'unauthorized' })
  })
})

describe('控制帧路由', () => {
  function paired() {
    const daemon = authDaemon()
    const code = makeCode(daemon)
    const browser = claim(code)
    const { sessionId } = last(browser)
    const b2 = authBrowser(T1, sessionId)
    return { daemon, browser, b2, sessionId }
  }

  it('dev-state 缓存并广播给该设备所有浏览器；后连接的浏览器收到缓存', () => {
    const { daemon, browser, sessionId } = paired()
    relay.handle(daemon, { t: 'dev-state', state: { bots: [{ id: 'a' }] } }, { ip: IP })
    expect(last(browser)).toMatchObject({ t: 'dev-state', deviceId: D1, state: { bots: [{ id: 'a' }] } })
    expect(last(browser).ts).toBe(0)

    const late = authBrowser(T1, sessionId)
    expect(late.sent.map((f) => f.t)).toEqual(['dev-auth-ok', 'dev-state'])
  })

  it('dev-cmd 只到该设备 daemon，带 from；to 不符不转发', () => {
    const { daemon, browser, sessionId } = paired()
    relay.handle(browser, { t: 'dev-cmd', to: D1, id: 'c1', cmd: 'deck.get', args: {} }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'dev-cmd', from: sessionId, id: 'c1', cmd: 'deck.get', args: {} })

    const before = daemon.sent.length
    relay.handle(browser, { t: 'dev-cmd', to: 'ffffffffffffffff', id: 'c2', cmd: 'deck.get' }, { ip: IP })
    expect(daemon.sent.length).toBe(before)
  })

  it('dev-res 回到该设备所有浏览器；无 daemon 时 dev-cmd 回 offline', () => {
    const { daemon, browser, b2 } = paired()
    relay.handle(daemon, { t: 'dev-res', id: 'c1', ok: true, err: null }, { ip: IP })
    expect(last(browser)).toEqual({ t: 'dev-res', id: 'c1', ok: true, err: null })
    expect(last(b2)).toEqual({ t: 'dev-res', id: 'c1', ok: true, err: null })

    relay.onClose(daemon)
    relay.handle(browser, { t: 'dev-cmd', id: 'c2', cmd: 'deck.get' }, { ip: IP })
    expect(last(browser)).toEqual({ t: 'dev-res', id: 'c2', ok: false, err: 'offline' })
  })

  it('含 apiKey 的状态/命令一律拒绝且不转发', () => {
    const { daemon, browser } = paired()
    relay.handle(daemon, { t: 'dev-state', state: { bots: [{ id: 'a', apiKey: 'sk-x' }] } }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'error', msg: 'bad frame' })
    expect(types(browser)).not.toContain('dev-state')

    relay.handle(browser, { t: 'dev-cmd', id: 'c1', cmd: 'bot.update', args: { apiKey: 'sk-x' } }, { ip: IP })
    expect(last(browser)).toEqual({ t: 'dev-res', id: 'c1', ok: false, err: 'bad args' })
  })

  it('daemon 断开 → 浏览器收 dev-offline；浏览器断开不删服务端 session', () => {
    const { daemon, browser, sessionId } = paired()
    relay.onClose(daemon)
    expect(last(browser)).toEqual({ t: 'dev-offline', deviceId: D1 })
    relay.onClose(browser)
    expect(store.get(D1).sessions[sessionId]).toBeTruthy()
  })
})

describe('会话列表与撤销', () => {
  function twoSessions() {
    const daemon = authDaemon()
    const b1 = claim(makeCode(daemon), 'PC')
    const s1 = last(b1).sessionId
    const b2 = claim(makeCode(daemon), 'Phone')
    const s2 = last(b2).sessionId
    return { daemon, b1, b2, s1, s2 }
  }

  it('dev-sessions 列两个会话并标在线', () => {
    const { b1, s1, s2 } = twoSessions()
    relay.handle(b1, { t: 'dev-sessions', id: 'q1' }, { ip: IP })
    const res = last(b1)
    expect(res.t).toBe('dev-sessions-res')
    expect(res.id).toBe('q1')
    expect(res.sessions.map((s) => s.sessionId)).toEqual([s1, s2])
    expect(res.sessions.every((s) => s.online === true)).toBe(true)
    expect(res.sessions.map((s) => s.label)).toEqual(['PC', 'Phone'])
  })

  it('撤销单个会话：目标收 dev-revoked 并断开，不能重连；其他 session 不受影响', () => {
    const { b1, b2, s1, s2 } = twoSessions()
    relay.handle(b1, { t: 'dev-session-revoke', id: 'r1', sessionId: s2 }, { ip: IP })
    expect(last(b1)).toEqual({ t: 'dev-res', id: 'r1', ok: true, err: null })
    expect(last(b2)).toEqual({ t: 'dev-revoked' })
    expect(b2.closed).toEqual({ code: 4003, reason: 'revoked' })
    expect(store.get(D1).sessions[s2]).toBeUndefined()
    expect(store.get(D1).sessions[s1]).toBeTruthy()

    expect(last(authBrowser(T1, s2))).toEqual({ t: 'dev-auth-err' })
    expect(last(authBrowser(T1, s1))).toMatchObject({ t: 'dev-auth-ok', role: 'browser' })
  })

  it('revoke-all：旧 token/session 全线失效，新 token 重新配对可用', () => {
    const daemon = authDaemon()
    const oldCode = makeCode(daemon)
    const b1 = claim(oldCode)
    const oldSession = last(b1).sessionId
    const b2 = claim(makeCode(daemon))
    const staleCode = makeCode(daemon) // 轮换前挂起的配对码必须作废

    const T3 = 'd'.repeat(64)
    const D3 = deriveDeviceId(T3)
    relay.handle(daemon, { t: 'dev-revoke-all', newToken: T3 }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'dev-revoke-ok', deviceId: D3 })

    expect(last(b1)).toEqual({ t: 'dev-revoked' })
    expect(last(b2)).toEqual({ t: 'dev-revoked' })
    expect(b1.closed.code).toBe(4003)
    expect(store.get(D1)).toBe(null)
    expect(store.get(D3).sessions).toEqual({})
    expect(last(claim(staleCode))).toEqual({ t: 'pair-error' })
    expect(last(authBrowser(T1, oldSession))).toEqual({ t: 'dev-auth-err' })

    // daemon 已换 key：用新设备身份重新发码，新浏览器可用新 token 配对
    const code2 = makeCode(daemon)
    const fresh = claim(code2)
    expect(last(fresh)).toMatchObject({ t: 'pair-ok', deviceId: D3, token: T3 })
    relay.handle(daemon, { t: 'dev-state', state: { ok: 1 } }, { ip: IP })
    expect(last(fresh)).toMatchObject({ t: 'dev-state', state: { ok: 1 } })
  })

  it('revoke-all 非法输入：同 token / 坏 token / 撞已有设备 → dev-revoke-err 且设备不变', () => {
    const daemon = authDaemon()
    claim(makeCode(daemon)) // 让 D1 真正落盘，才能断言“设备不变”
    relay.handle(daemon, { t: 'dev-revoke-all', newToken: T1 }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'dev-revoke-err' })

    relay.handle(daemon, { t: 'dev-revoke-all', newToken: 'nope' }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'dev-revoke-err' })

    const T4 = 'e'.repeat(64)
    store.upsert(deriveDeviceId(T4), { tokenHash: hashToken(T4), name: 'other', createdAt: 1, sessions: {} })
    relay.handle(daemon, { t: 'dev-revoke-all', newToken: T4 }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'dev-revoke-err' })
    expect(store.get(D1)).toBeTruthy()
  })
})

describe('限速与未知帧', () => {
  it('每连接帧预算：超限回 rate 且不再处理', () => {
    makeRelay({ frameLimit: 3 })
    const daemon = authDaemon() // 1
    relay.handle(daemon, { t: 'dev-state', state: { n: 1 } }, { ip: IP }) // 2
    relay.handle(daemon, { t: 'dev-state', state: { n: 2 } }, { ip: IP }) // 3
    relay.handle(daemon, { t: 'dev-state', state: { n: 3 } }, { ip: IP }) // 4 → rate
    expect(last(daemon)).toMatchObject({ t: 'rate' })
    const browser = authBrowser(T1, '0'.repeat(16)) // no session, irrelevant
    expect(browser.sent[0].t).toBe('dev-auth-err')
  })

  it('未知设备帧 → bad frame，不抛', () => {
    const daemon = authDaemon()
    relay.handle(daemon, { t: 'nope' }, { ip: IP })
    expect(last(daemon)).toEqual({ t: 'error', msg: 'bad frame' })
  })

  it('pair-new 预算 5/60s：第 6 次回 rate', () => {
    const daemon = authDaemon()
    for (let i = 0; i < 5; i++) {
      relay.handle(daemon, { t: 'pair-new' }, { ip: IP })
      expect(last(daemon).t).toBe('pair-code')
    }
    relay.handle(daemon, { t: 'pair-new' }, { ip: IP })
    expect(last(daemon)).toMatchObject({ t: 'rate' })
  })
})
