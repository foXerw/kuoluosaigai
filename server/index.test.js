import { describe, it, expect, vi, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createServer, sweepClients } from './index.js'

describe('chat server', () => {
  let server, url

  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  function connect(path = '') {
    return new Promise((resolve) => {
      const ws = new WebSocket(url + path)
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

  async function boot() {
    server = createServer()
    const port = await server.start(0)
    url = `ws://localhost:${port}`
  }

  it('assigns a nick and presence on connect', async () => {
    await boot()
    const { ws, received } = await connect()
    const assign = await nextFrame(received)
    expect(assign.type).toBe('assign')
    expect(assign.nick).toMatch(/^ANON-[A-Z2-9]{4}$/)
    const presence = await nextFrame(received)
    expect(presence).toEqual({ type: 'presence', online: 1 })
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

  it('broadcasts messages with badge and truncates text over 280 chars', async () => {
    await boot()
    const { ws, received } = await connect()
    await nextFrame(received) // assign
    await nextFrame(received) // presence
    ws.send(JSON.stringify({ type: 'message', text: 'a'.repeat(300), badge: 'SETSUBUN' }))
    const msg = await nextFrame(received)
    expect(msg.type).toBe('message')
    expect(msg.badge).toBe('SETSUBUN')
    expect(msg.text).toHaveLength(280)
    expect(msg.nick).toMatch(/^ANON-/)
    expect(typeof msg.ts).toBe('number')
    ws.close()
  })

  it('rate-limits after 10 messages/minute and suppresses broadcast', async () => {
    await boot()
    const { ws, received } = await connect()
    await nextFrame(received) // assign
    await nextFrame(received) // presence
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'message', text: `m${i}`, badge: '' }))
      const f = await nextFrame(received)
      expect(f.type).toBe('message')
    }
    ws.send(JSON.stringify({ type: 'message', text: 'over', badge: '' }))
    const frame = await nextFrame(received)
    expect(frame.type).toBe('rate')
    ws.close()
  })

  it('broadcasts join/leave and presence to other clients', async () => {
    await boot()
    const a = await connect()
    await nextFrame(a.received) // assign
    await nextFrame(a.received) // presence(1)
    const b = await connect()
    const join = await nextFrame(a.received)
    expect(join.type).toBe('join')
    expect(join.nick).toMatch(/^ANON-/)
    const presence2 = await nextFrame(a.received)
    expect(presence2).toEqual({ type: 'presence', online: 2 })
    await nextFrame(b.received) // b assign
    await nextFrame(b.received) // b presence(2)
    b.ws.close()
    const leave = await nextFrame(a.received)
    expect(leave.type).toBe('leave')
    const presence1 = await nextFrame(a.received)
    expect(presence1).toEqual({ type: 'presence', online: 1 })
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
})
