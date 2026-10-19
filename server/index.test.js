import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, sweepClients } from './index.js'

// 注册表统一落临时目录：每个 boot 一个新文件，避免用例间注册表串味，也不写默认生产路径
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-rooms-'))
let roomsSeq = 0

describe('chat server', () => {
  let server, url

  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  function connect(pathname = '') {
    return new Promise((resolve) => {
      const ws = new WebSocket(url + pathname)
      const received = []
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
      ws.on('open', () => resolve({ ws, received }))
    })
  }

  function nextFrame(received, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame timeout')), timeout)
      const check = () => {
        if (received.length) {
          clearTimeout(timer)
          resolve(received.shift())
        } else {
          setTimeout(check, 5)
        }
      }
      check()
    })
  }

  // 等待服务端安静下来：用于断言「不该收到的帧确实没来」
  function settle(ms = 80) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function boot(opts = {}) {
    server = createServer({ roomsFile: path.join(TMP_ROOT, `rooms-${roomsSeq++}.log`), ...opts })
    const port = await server.start(0)
    url = `ws://localhost:${port}`
    return server
  }

  // 发 join 帧并等待该连接的直接回执（joined 或 join-error）
  async function joinRoom(conn, roomId) {
    conn.ws.send(JSON.stringify({ type: 'join', roomId }))
    return nextFrame(conn.received)
  }

  function send(conn, frame) {
    conn.ws.send(JSON.stringify(frame))
  }

  it('assigns a nick on connect and sends nothing else (no global presence)', async () => {
    await boot()
    const { ws, received } = await connect()
    const assign = await nextFrame(received)
    expect(assign.type).toBe('assign')
    expect(assign.nick).toMatch(/^ANON-[A-Z2-9]{4}$/)
    await settle()
    expect(received).toHaveLength(0) // v2：连接阶段不再广播 presence/join
    ws.close()
  })

  it('reuses a valid nick passed via query string', async () => {
    await boot()
    const { ws, received } = await connect('?nick=ANON-TEST')
    const assign = await nextFrame(received)
    expect(assign.type).toBe('assign')
    expect(assign.nick).toBe('ANON-TEST')
    ws.close()
  })

  it('ignores an invalid nick in the query string and assigns a random one', async () => {
    await boot()
    const { ws, received } = await connect('?nick=hacker')
    const assign = await nextFrame(received)
    expect(assign.type).toBe('assign')
    expect(assign.nick).toMatch(/^ANON-[A-HJ-NP-Z2-9]{4}$/)
    expect(assign.nick).not.toBe('hacker')
    ws.close()
  })

  it('broadcasts messages in room with badge, id, ts and truncates text over 280 chars', async () => {
    await boot()
    const conn = await connect()
    await nextFrame(conn.received) // assign
    const joined = await joinRoom(conn, 'magenta')
    expect(joined.type).toBe('joined')
    send(conn, { type: 'message', text: 'a'.repeat(300), badge: 'SETSUBUN' })
    const msg = await nextFrame(conn.received)
    expect(msg.type).toBe('message')
    expect(msg.roomId).toBe('magenta')
    expect(msg.badge).toBe('SETSUBUN')
    expect(msg.text).toHaveLength(280)
    expect(msg.nick).toMatch(/^ANON-/)
    expect(typeof msg.ts).toBe('number')
    expect(typeof msg.id).toBe('string')
    conn.ws.close()
  })

  it('rate-limits after 10 messages/minute and suppresses broadcast', async () => {
    await boot()
    const conn = await connect()
    await nextFrame(conn.received) // assign
    await joinRoom(conn, 'magenta')
    for (let i = 0; i < 10; i++) {
      send(conn, { type: 'message', text: `m${i}`, badge: '' })
      const f = await nextFrame(conn.received)
      expect(f.type).toBe('message')
    }
    send(conn, { type: 'message', text: 'over', badge: '' })
    const frame = await nextFrame(conn.received)
    expect(frame.type).toBe('rate')
    conn.ws.close()
  })

  it('broadcasts room join/leave and presence to roommates', async () => {
    await boot()
    const a = await connect('?nick=ANON-AAAA')
    const b = await connect('?nick=ANON-BBBB')
    await nextFrame(a.received) // assign
    await nextFrame(b.received) // assign
    await joinRoom(a, 'setsubun')
    await joinRoom(b, 'setsubun')
    const joinEv = await nextFrame(a.received)
    expect(joinEv).toMatchObject({ type: 'join', roomId: 'setsubun', nick: 'ANON-BBBB' })
    expect(typeof joinEv.ts).toBe('number')
    const presence2 = await nextFrame(a.received)
    expect(presence2).toEqual({ type: 'presence', roomId: 'setsubun', online: 2 })
    b.ws.close()
    const leave = await nextFrame(a.received)
    expect(leave).toMatchObject({ type: 'leave', roomId: 'setsubun', nick: 'ANON-BBBB' })
    const presence1 = await nextFrame(a.received)
    expect(presence1).toEqual({ type: 'presence', roomId: 'setsubun', online: 1 })
    a.ws.close()
  })

  it('sweepClients terminates dead sockets and pings live ones', () => {
    const dead = { isAlive: false, terminate: vi.fn(), ping: vi.fn() }
    const live = { isAlive: true, terminate: vi.fn(), ping: vi.fn() }
    sweepClients([dead, live])
    expect(dead.terminate).toHaveBeenCalledTimes(1)
    expect(dead.ping).not.toHaveBeenCalled()
    expect(live.terminate).not.toHaveBeenCalled()
    expect(live.ping).toHaveBeenCalledTimes(1)
    expect(live.isAlive).toBe(false)
  })

  describe('multi-room', () => {
    it('joins a public room and replies joined with online count and selfId', async () => {
      await boot()
      const conn = await connect()
      await nextFrame(conn.received) // assign
      const joined = await joinRoom(conn, 'nebula')
      expect(joined.type).toBe('joined')
      expect(joined.roomId).toBe('nebula')
      expect(joined.online).toBe(1)
      expect(Number.isInteger(joined.selfId)).toBe(true)
      await settle()
      expect(conn.received).toHaveLength(0) // 同房只有自己时不再向自己广播 join/presence
      conn.ws.close()
    })

    it('rejects unknown room id and still allows joining a valid room afterwards', async () => {
      await boot()
      const conn = await connect()
      await nextFrame(conn.received) // assign
      const err = await joinRoom(conn, 'zzzzzz')
      expect(err).toEqual({ type: 'join-error', roomId: 'zzzzzz', reason: 'unknown' })
      const joined = await joinRoom(conn, 'nebula')
      expect(joined.type).toBe('joined')
      expect(joined.roomId).toBe('nebula')
      conn.ws.close()
    })

    it('counts the second member and notifies the earlier one with roomId', async () => {
      await boot()
      const a = await connect('?nick=ANON-AAAA')
      const b = await connect('?nick=ANON-BBBB')
      await nextFrame(a.received)
      await nextFrame(b.received)
      await joinRoom(a, 'setsubun')
      const bJoined = await joinRoom(b, 'setsubun')
      expect(bJoined.online).toBe(2)
      const joinEv = await nextFrame(a.received)
      expect(joinEv.type).toBe('join')
      expect(joinEv.roomId).toBe('setsubun')
      a.ws.close()
      b.ws.close()
    })

    it('routes messages only inside the sender room and stamps boot-scoped ids', async () => {
      await boot()
      const a = await connect()
      const b = await connect()
      await nextFrame(a.received)
      await nextFrame(b.received)
      await joinRoom(a, 'setsubun')
      await joinRoom(b, 'nebula')
      send(a, { type: 'message', text: 'room-a-1', badge: '' })
      send(a, { type: 'message', text: 'room-a-2', badge: '' })
      const m1 = await nextFrame(a.received)
      const m2 = await nextFrame(a.received)
      expect(m1).toMatchObject({ type: 'message', roomId: 'setsubun', text: 'room-a-1' })
      expect(m2.type).toBe('message')
      // id = 进程级 4 位 bootToken 前缀 + base36 自增号（重启后前缀换、号重置）
      expect(m1.id.slice(4)).toMatch(/^[0-9a-z]+$/)
      expect(m2.id.slice(0, 4)).toBe(m1.id.slice(0, 4))
      expect(parseInt(m2.id.slice(4), 36)).toBeGreaterThan(parseInt(m1.id.slice(4), 36))
      // B 房连接收不到 A 房消息
      await settle()
      expect(b.received.filter((f) => f.type === 'message')).toHaveLength(0)
      a.ws.close()
      b.ws.close()
    })

    it('switching rooms removes from the old room atomically and re-scopes messages', async () => {
      await boot()
      const a = await connect('?nick=ANON-AAAA')
      const mate = await connect('?nick=ANON-BBBB')
      const c = await connect('?nick=ANON-CCCC')
      await nextFrame(a.received)
      await nextFrame(mate.received)
      await nextFrame(c.received)
      const joinedA = await joinRoom(a, 'setsubun')
      const joinedMate = await joinRoom(mate, 'setsubun')
      await nextFrame(a.received) // join(mate)
      await nextFrame(a.received) // presence(2)
      // A 切到 nebula：setsubun 的同伴收到 leave + presence{online:1}
      const joined = await joinRoom(a, 'nebula')
      expect(joined).toMatchObject({ type: 'joined', roomId: 'nebula', online: 1 })
      // selfId = 进程内连接号：是整数、跨切房稳定、不同连接互不相同
      expect(Number.isInteger(joined.selfId)).toBe(true)
      expect(joined.selfId).toBe(joinedA.selfId)
      expect(joinedMate.selfId).not.toBe(joinedA.selfId)
      const leave = await nextFrame(mate.received)
      expect(leave).toMatchObject({ type: 'leave', roomId: 'setsubun', nick: 'ANON-AAAA' })
      const presence = await nextFrame(mate.received)
      expect(presence).toEqual({ type: 'presence', roomId: 'setsubun', online: 1 })
      // 切房后发言只到新房成员
      await joinRoom(c, 'nebula')
      send(a, { type: 'message', text: 'only-nebula', badge: '' })
      const msg = await nextFrame(c.received)
      expect(msg).toMatchObject({ type: 'message', roomId: 'nebula', nick: 'ANON-AAAA', text: 'only-nebula' })
      await settle()
      expect(mate.received.filter((f) => f.type === 'message')).toHaveLength(0)
      a.ws.close()
      mate.ws.close()
      c.ws.close()
    })

    it('re-joining the current room re-acks joined without any roommate churn', async () => {
      await boot()
      const a = await connect('?nick=ANON-AAAA')
      const b = await connect('?nick=ANON-BBBB')
      await nextFrame(a.received) // assign
      await nextFrame(b.received) // assign
      const joinedA = await joinRoom(a, 'magenta')
      await joinRoom(b, 'magenta')
      await nextFrame(a.received) // join(b)
      await nextFrame(a.received) // presence(2)
      // 幂等语义（Task 3 改造 joinRoom 时的回归钉）：重复 join 当前房只回 joined
      const rejoin = await joinRoom(a, 'magenta')
      expect(rejoin).toMatchObject({ type: 'joined', roomId: 'magenta', online: 2 })
      expect(rejoin.selfId).toBe(joinedA.selfId)
      await settle()
      expect(a.received).toHaveLength(0)
      expect(b.received).toHaveLength(0) // 同伴没有收到任何 leave/join/presence
      a.ws.close()
      b.ws.close()
    })

    it('rejects the third joiner when roomCap is reached', async () => {
      await boot({ roomCap: 2 })
      const a = await connect()
      const b = await connect()
      const c = await connect()
      await nextFrame(a.received) // assign
      await nextFrame(b.received) // assign
      await nextFrame(c.received) // assign
      await joinRoom(a, 'amber')
      await joinRoom(b, 'amber')
      const err = await joinRoom(c, 'amber')
      expect(err).toEqual({ type: 'join-error', roomId: 'amber', reason: 'full' })
      a.ws.close()
      b.ws.close()
      c.ws.close()
    })

    it('create issues a new id, replies created+joined and appends to the registry file', async () => {
      const roomsFile = path.join(TMP_ROOT, 'create-room.log')
      await boot({ roomsFile })
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'create' })
      const created = await nextFrame(conn.received)
      expect(created.type).toBe('created')
      expect(created.roomId).toMatch(/^[a-z0-9]{6}$/)
      const joined = await nextFrame(conn.received)
      expect(joined).toMatchObject({ type: 'joined', roomId: created.roomId, online: 1 })
      const lines = fs.readFileSync(roomsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      expect(lines[lines.length - 1]).toBe(created.roomId)
      conn.ws.close()
    })

    it('errors on message before join and stays silent on Task-3 frames', async () => {
      await boot()
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'message', text: 'orphan', badge: '' })
      const err = await nextFrame(conn.received)
      expect(err).toEqual({ type: 'error', msg: 'not in room' })
      // history-req/history-res/counts 由 Task 3 接线：本任务必须静默忽略而非报错
      send(conn, { type: 'history-req' })
      send(conn, { type: 'history-res', roomId: 'nebula', to: 1, messages: [] })
      send(conn, { type: 'counts', roomIds: ['nebula'] })
      await settle()
      expect(conn.received).toHaveLength(0)
      conn.ws.close()
    })

    it('keeps created rooms joinable after restart with the same roomsFile', async () => {
      const roomsFile = path.join(TMP_ROOT, 'restart-room.log')
      const first = await boot({ roomsFile })
      const a = await connect()
      await nextFrame(a.received)
      send(a, { type: 'create' })
      const created = await nextFrame(a.received)
      await nextFrame(a.received) // joined
      const roomId = created.roomId
      a.ws.close()
      await first.close()
      server = null // 旧实例已手动关闭，避免 afterEach 重复 close

      await boot({ roomsFile })
      const b = await connect()
      await nextFrame(b.received)
      const joined = await joinRoom(b, roomId)
      expect(joined).toMatchObject({ type: 'joined', roomId, online: 1 })
      b.ws.close()
    })
  })
})
