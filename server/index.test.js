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

  it('默认 nick / 房号 / 消息 id 前缀不依赖 Math.random', async () => {
    const original = Math.random
    Math.random = () => { throw new Error('Math.random must not be used') }
    try {
      await boot()
      const c = await connect()
      const assign = await nextFrame(c.received)
      expect(assign.nick).toMatch(/^ANON-[A-HJ-NP-Z2-9]{4}$/)
      send(c, { type: 'create' })
      const created = await nextFrame(c.received)
      expect(created.type).toBe('created')
      expect(created.roomId).toMatch(/^[a-z0-9]{6}$/)
      c.ws.close()
    } finally {
      Math.random = original
    }
  })

  it('恶意对象字段（toString 不可调用）只坏单帧，不打崩进程', async () => {
    await boot()
    const c = await connect()
    await nextFrame(c.received)
    // join.roomId 是对象：不得 String() 抛错，按空房间处理
    send(c, { type: 'join', roomId: { toString: 123 } })
    expect(await nextFrame(c.received)).toMatchObject({ type: 'join-error', reason: 'unknown' })
    await joinRoom(c, 'magenta')
    send(c, { type: 'message', text: { toString: 123 }, badge: { toString: 123 } })
    const msg = await nextFrame(c.received)
    expect(msg.type).toBe('message')
    expect(msg.text).toBe('')
    expect(msg.badge).toBe('')
    // counts 里的对象键同样过滤
    send(c, { type: 'counts', roomIds: [{ toString: 123 }, 'magenta'] })
    const counts = await nextFrame(c.received)
    expect(counts.counts).toEqual({ magenta: 1 })
    // 进程还活着：新连接照常 assign
    const d = await connect()
    expect((await nextFrame(d.received)).type).toBe('assign')
    c.ws.close()
    d.ws.close()
  })

  it('badge 超过 32 字符被截断（不再把任意长自报串广播给全房）', async () => {
    await boot()
    const conn = await connect()
    await nextFrame(conn.received)
    await joinRoom(conn, 'magenta')
    send(conn, { type: 'message', text: 'hi', badge: 'B'.repeat(100) })
    const msg = await nextFrame(conn.received)
    expect(msg.badge).toBe('B'.repeat(32))
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

    it('errors on message before join and drops relay frames when outside a room', async () => {
      await boot()
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'message', text: 'orphan', badge: '' })
      const err = await nextFrame(conn.received)
      expect(err).toEqual({ type: 'error', msg: 'not in room' })
      // Task 3 语义：history-req 请求者本就不收；history-res 同房校验失败整帧丢弃
      send(conn, { type: 'history-req' })
      send(conn, { type: 'history-res', roomId: 'nebula', to: 1, messages: [] })
      await settle()
      expect(conn.received).toHaveLength(0)
      // counts 与入房无关：接线后不再静默，直接应答请求者
      send(conn, { type: 'counts', roomIds: ['nebula'] })
      const counted = await nextFrame(conn.received)
      expect(counted).toEqual({ type: 'counts', counts: { nebula: 0 } })
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

  describe('history relay, counts and script guards', () => {
    it('relays history-req to same-room peers only, stamped with the requester selfId', async () => {
      await boot()
      const a = await connect('?nick=ANON-AAAA')
      const b = await connect('?nick=ANON-BBBB')
      const c = await connect('?nick=ANON-CCCC')
      await nextFrame(a.received)
      await nextFrame(b.received)
      await nextFrame(c.received)
      const joinedA = await joinRoom(a, 'setsubun')
      await joinRoom(b, 'setsubun')
      await joinRoom(c, 'nebula')
      await nextFrame(a.received) // join(b)
      await nextFrame(a.received) // presence(2)
      send(a, { type: 'history-req' })
      const req = await nextFrame(b.received)
      expect(req).toEqual({ type: 'history-req', roomId: 'setsubun', from: joinedA.selfId })
      await settle()
      expect(a.received).toHaveLength(0) // 请求者不收（自己就是响应者）
      expect(c.received).toHaveLength(0) // 房外同伴收不到
      a.ws.close()
      b.ws.close()
      c.ws.close()
    })

    it('history-req 只扇出给至多 historyReplyCap 个同房成员（默认 3）', async () => {
      await boot({ historyReplyCap: 3 })
      const conns = []
      for (let i = 0; i < 5; i++) {
        const c = await connect()
        await nextFrame(c.received)
        await joinRoom(c, 'magenta')
        conns.push(c)
      }
      for (const c of conns) c.received.length = 0
      send(conns[0], { type: 'history-req' })
      await settle(120)
      const got = conns.slice(1).filter((c) => c.received.some((f) => f.type === 'history-req'))
      expect(got).toHaveLength(3)
      expect(conns[0].received).toHaveLength(0)
      for (const c of conns) c.ws.close()
    })

    it('historyReplyCap=1：两名同房peer中只有一人收到，请求者仍不收', async () => {
      await boot({ historyReplyCap: 1 })
      const a = await connect()
      const b = await connect()
      const c = await connect()
      for (const x of [a, b, c]) await nextFrame(x.received)
      await joinRoom(a, 'amber')
      await joinRoom(b, 'amber')
      await joinRoom(c, 'amber')
      for (const x of [a, b, c]) x.received.length = 0
      send(a, { type: 'history-req' })
      await settle(120)
      const got = [b, c].filter((x) => x.received.some((f) => f.type === 'history-req'))
      expect(got).toHaveLength(1)
      expect(a.received).toHaveLength(0)
      for (const x of [a, b, c]) x.ws.close()
    })

    it('delivers history-res to the requester after the three-way same-room check', async () => {
      await boot()
      const a = await connect()
      const b = await connect()
      await nextFrame(a.received)
      await nextFrame(b.received)
      const joinedA = await joinRoom(a, 'setsubun')
      const joinedB = await joinRoom(b, 'setsubun')
      await nextFrame(a.received) // join(b)
      await nextFrame(a.received) // presence(2)
      const msgs = [
        { id: 'x1', ts: 1, roomId: 'setsubun' },
        { id: 'x2', ts: 2, roomId: 'setsubun' },
        { id: 'x3', ts: 3, roomId: 'setsubun' },
      ]
      send(b, { type: 'history-res', roomId: 'setsubun', to: joinedA.selfId, messages: msgs })
      const res = await nextFrame(a.received)
      expect(res).toEqual({ type: 'history-res', roomId: 'setsubun', from: joinedB.selfId, messages: msgs })
      await settle()
      expect(b.received).toHaveLength(0) // 响应者没有额外回执
      a.ws.close()
      b.ws.close()
    })

    it('drops history-res when the requester has switched to another room', async () => {
      await boot()
      const a = await connect()
      const b = await connect()
      await nextFrame(a.received)
      await nextFrame(b.received)
      const joinedA = await joinRoom(a, 'setsubun')
      await joinRoom(b, 'setsubun')
      await nextFrame(a.received) // join(b)
      await nextFrame(a.received) // presence(2)
      await joinRoom(a, 'nebula') // A 切房，selfId 不变
      await nextFrame(b.received) // leave(a)
      await nextFrame(b.received) // presence(1)
      // 跨房污染用例：B 迟发指向旧房 setsubun 的 history-res，目标校验失败 → 整帧丢弃
      send(b, {
        type: 'history-res',
        roomId: 'setsubun',
        to: joinedA.selfId,
        messages: [{ id: 'x1', ts: 1, roomId: 'setsubun' }],
      })
      await settle()
      expect(a.received).toHaveLength(0)
      expect(b.received).toHaveLength(0) // 丢弃无回执、无错误帧
      a.ws.close()
      b.ws.close()
    })

    it('truncates history-res messages to the last historyRespMax entries', async () => {
      await boot({ historyRespMax: 2 })
      const a = await connect()
      const b = await connect()
      await nextFrame(a.received)
      await nextFrame(b.received)
      const joinedA = await joinRoom(a, 'setsubun')
      await joinRoom(b, 'setsubun')
      await nextFrame(a.received) // join(b)
      await nextFrame(a.received) // presence(2)
      send(b, {
        type: 'history-res',
        roomId: 'setsubun',
        to: joinedA.selfId,
        messages: [
          { id: 'm1', ts: 1, roomId: 'setsubun' },
          { id: 'm2', ts: 2, roomId: 'setsubun' },
          { id: 'm3', ts: 3, roomId: 'setsubun' },
        ],
      })
      const res = await nextFrame(a.received)
      expect(res.type).toBe('history-res')
      expect(res.messages.map((m) => m.id)).toEqual(['m2', 'm3']) // 保留最后 2 条
      a.ws.close()
      b.ws.close()
    })

    it('answers counts with online numbers for registered ids and omits unknown ids', async () => {
      await boot()
      const a = await connect()
      await nextFrame(a.received) // assign
      send(a, { type: 'create' })
      const created = await nextFrame(a.received)
      await nextFrame(a.received) // joined
      send(a, { type: 'counts', roomIds: ['nebula', created.roomId, 'zzzzzz'] })
      const f = await nextFrame(a.received)
      // 精确匹配：nebula 无人在线为 0，私房在线 1，未知 ID 键缺席
      expect(f).toEqual({ type: 'counts', counts: { nebula: 0, [created.roomId]: 1 } })
      a.ws.close()
    })

    it('silently truncates counts batches beyond countsBatchMax', async () => {
      await boot({ countsBatchMax: 2 })
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'counts', roomIds: ['nebula', 'setsubun', 'magenta', 'amber'] })
      const f = await nextFrame(conn.received)
      expect(f).toEqual({ type: 'counts', counts: { nebula: 0, setsubun: 0 } }) // 取前 2 个，静默不报错
      conn.ws.close()
    })

    it('rate-limits all further joins once the unknown-fail window saturates', async () => {
      await boot({ joinFailLimit: 2 })
      const conn = await connect()
      await nextFrame(conn.received) // assign
      const e1 = await joinRoom(conn, 'zzz001')
      expect(e1).toMatchObject({ type: 'join-error', reason: 'unknown' })
      const e2 = await joinRoom(conn, 'zzz002')
      expect(e2).toMatchObject({ type: 'join-error', reason: 'unknown' })
      // 窗口饱和后合法 ID 也一律 rate，不再探测注册表
      const third = await joinRoom(conn, 'nebula')
      expect(third).toMatchObject({ type: 'rate' })
      await settle()
      expect(conn.received).toHaveLength(0) // rate 之外没有 joined/join-error 尾巴
      conn.ws.close()
    })

    it('does not count join-error:full toward the join-fail window', async () => {
      await boot({ roomCap: 1, joinFailLimit: 1 })
      const a = await connect()
      await nextFrame(a.received)
      await joinRoom(a, 'amber')
      const b = await connect()
      await nextFrame(b.received)
      const full = await joinRoom(b, 'amber')
      expect(full).toEqual({ type: 'join-error', roomId: 'amber', reason: 'full' })
      // full 不计入失败窗：紧随其后的合法 join 仍应成功
      const joined = await joinRoom(b, 'setsubun')
      expect(joined).toMatchObject({ type: 'joined', roomId: 'setsubun' })
      // limit=1：一次 unknown 即饱和，其后 join 一律 rate
      const unknown = await joinRoom(b, 'zzz999')
      expect(unknown).toMatchObject({ type: 'join-error', reason: 'unknown' })
      const rate = await joinRoom(b, 'nebula')
      expect(rate).toMatchObject({ type: 'rate' })
      a.ws.close()
      b.ws.close()
    })

    it('throttles successful switches past switchLimit; re-joins and failures do not consume budget', async () => {
      await boot({ switchLimit: 2 })
      const a = await connect('?nick=ANON-AAAA')
      const mate = await connect('?nick=ANON-BBBB')
      await nextFrame(a.received) // assign
      await nextFrame(mate.received) // assign
      // 成功 #1；其间一次 unknown 失败不计入切房窗（它从未进过房）
      expect(await joinRoom(a, 'setsubun')).toMatchObject({ type: 'joined', roomId: 'setsubun' })
      expect(await joinRoom(a, 'zzz999')).toMatchObject({ type: 'join-error', reason: 'unknown' })
      // 成功 #2 → 切房窗饱和
      expect(await joinRoom(a, 'magenta')).toMatchObject({ type: 'joined', roomId: 'magenta' })
      // mate 进 a 当前房，成为「a 没离开」的证人
      await joinRoom(mate, 'magenta')
      await nextFrame(a.received) // join(mate)
      await nextFrame(a.received) // presence(2)
      // 饱和后幂等重进当前房：照常回 joined，不消耗预算、不产生房内 churn
      expect(await joinRoom(a, 'magenta')).toMatchObject({ type: 'joined', roomId: 'magenta' })
      await settle()
      expect(a.received).toHaveLength(0)
      expect(mate.received).toHaveLength(0)
      // 第三次换房请求：窗口饱和 → rate 且不执行任何房间变更
      expect(await joinRoom(a, 'nebula')).toMatchObject({ type: 'rate' })
      expect(mate.received).toHaveLength(0) // a 没有离开 magenta（无幽灵 leave 广播）
      // 仍在 magenta 的佐证：mate 断开后 a 照常收本房 leave/presence
      mate.ws.close()
      const leave = await nextFrame(a.received)
      expect(leave).toMatchObject({ type: 'leave', roomId: 'magenta', nick: 'ANON-BBBB' })
      a.ws.close()
    })

    it('closes a connection beyond the 256KiB relay frame ceiling; lawful-size frames pass through', async () => {
      await boot()
      const a = await connect()
      const b = await connect()
      await nextFrame(a.received) // assign
      await nextFrame(b.received) // assign
      a.ws.on('error', () => {}) //  oversized 帧的后续 error 不作为用例失败
      // R8：上限必须容下协议合法最坏帧（historyRespMax 200 × 280 CJK ≈184KB）——
      // 64KiB 级大帧属合法尺寸，只许按坏 JSON 回执、不许 1009 掐断（旧 64KiB 上限在此必 RED）
      a.ws.send('x'.repeat(64 * 1024 + 1))
      expect(await nextFrame(a.received)).toEqual({ type: 'error', msg: 'bad frame' })
      const closed = new Promise((resolve) => a.ws.on('close', (code) => resolve(code)))
      a.ws.send('x'.repeat(256 * 1024 + 1))
      expect(await closed).toBe(1009) // Message Too Big：ws 层直接掐断该连接
      // 进程存活：另一条连接完全不受影响，入房、发言照常有回执
      const joined = await joinRoom(b, 'nebula')
      expect(joined).toMatchObject({ type: 'joined', roomId: 'nebula' })
      send(b, { type: 'message', text: 'still alive', badge: '' })
      const msg = await nextFrame(b.received)
      expect(msg).toMatchObject({ type: 'message', roomId: 'nebula', text: 'still alive' })
      b.ws.close()
    })

    it('survives a registry write failure: error frame, no phantom join, process alive', async () => {
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'doomed-'))
      const roomsFile = path.join(dir, 'rooms.log')
      await boot({ roomsFile }) // 构造完成：种子已落盘、注册表加载进内存 Set
      fs.rmSync(dir, { recursive: true, force: true }) // 事后抽走目录 → 后续 append 必抛 ENOENT
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'create' })
      const err = await nextFrame(conn.received)
      expect(err).toEqual({ type: 'error', msg: 'registry write failed' })
      await settle()
      expect(conn.received).toHaveLength(0) // 不得有 created/joined 幽灵回执
      expect(conn.ws.readyState).toBe(WebSocket.OPEN) // 连接继续存活
      // 进程没死：新连接照常入房（读内存 Set 不依赖文件）
      const b = await connect()
      await nextFrame(b.received)
      const joined = await joinRoom(b, 'nebula')
      expect(joined).toMatchObject({ type: 'joined', roomId: 'nebula' })
      conn.ws.close()
      b.ws.close()
    })

    it('rate-limits create beyond the window without touching the registry file', async () => {
      const roomsFile = path.join(TMP_ROOT, 'create-limit.log')
      await boot({ roomsFile, createLimit: 1 })
      const conn = await connect()
      await nextFrame(conn.received) // assign
      send(conn, { type: 'create' })
      const created = await nextFrame(conn.received)
      expect(created.type).toBe('created')
      await nextFrame(conn.received) // joined
      const countLines = () =>
        fs.readFileSync(roomsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).length
      const before = countLines()
      send(conn, { type: 'create' })
      const f = await nextFrame(conn.received)
      expect(f).toMatchObject({ type: 'rate' })
      await settle()
      expect(conn.received).toHaveLength(0) // 超限时不得有 created/joined 回执
      expect(countLines()).toBe(before) // 且完全没有落盘
      conn.ws.close()
    })

    it('全局建房闸：不同连接合计超限后回 rate（防分布式刷注册表）', async () => {
      const roomsFile = path.join(TMP_ROOT, 'create-global.log')
      await boot({ roomsFile, createLimit: 100, globalCreateLimit: 1 })
      const a = await connect()
      await nextFrame(a.received)
      send(a, { type: 'create' })
      expect((await nextFrame(a.received)).type).toBe('created')
      await nextFrame(a.received) // joined

      const b = await connect()
      await nextFrame(b.received)
      send(b, { type: 'create' })
      expect(await nextFrame(b.received)).toMatchObject({ type: 'rate' })
      await settle()
      expect(b.received).toHaveLength(0)
      a.ws.close()
      b.ws.close()
    })
  })
})
