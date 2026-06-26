import http from 'node:http'
import { WebSocketServer } from 'ws'

const NICK_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 剔除 O/I/0/1
const MAX_LEN = 280
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000

function genNick() {
  let s = 'ANON-'
  for (let i = 0; i < 4; i++) {
    s += NICK_CHARS[Math.floor(Math.random() * NICK_CHARS.length)]
  }
  return s
}

function now() {
  return Date.now()
}

export function createServer() {
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })
  const clients = new Map() // ws -> { nick, times: [] }

  function send(ws, frame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  function broadcast(frame, except = null) {
    const data = JSON.stringify(frame)
    for (const ws of clients.keys()) {
      if (ws === except || ws.readyState !== ws.OPEN) continue
      ws.send(data)
    }
  }

  function broadcastPresence() {
    broadcast({ type: 'presence', online: clients.size })
  }

  function rateLimited(info) {
    const t = now()
    info.times = info.times.filter((x) => t - x < RATE_WINDOW)
    if (info.times.length >= RATE_LIMIT) return true
    info.times.push(t)
    return false
  }

  wss.on('connection', (ws) => {
    const nick = genNick()
    const info = { nick, times: [] }
    clients.set(ws, info)

    send(ws, { type: 'assign', nick })
    broadcast({ type: 'join', nick, ts: now() }, ws)
    broadcastPresence()

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        send(ws, { type: 'error', msg: 'bad frame' })
        return
      }
      if (frame.type !== 'message') return
      if (rateLimited(info)) {
        send(ws, { type: 'rate', ts: now() })
        return
      }
      const text = String(frame.text || '').slice(0, MAX_LEN)
      broadcast({
        type: 'message',
        nick,
        badge: String(frame.badge || ''),
        text,
        ts: now(),
      })
    })

    ws.on('close', () => {
      if (!clients.delete(ws)) return
      broadcast({ type: 'leave', nick, ts: now() })
      broadcastPresence()
    })

    ws.on('error', () => {
      // swallow; the 'close' handler cleans up the clients map and broadcasts leave/presence
    })
  })

  wss.on('error', () => {
    // swallow server-level socket errors
  })

  return {
    start(port = 0) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => resolve(httpServer.address().port))
      })
    },
    close() {
      return new Promise((resolve) => {
        for (const ws of clients.keys()) ws.close()
        clients.clear()
        wss.close(() => httpServer.close(() => resolve()))
      })
    },
  }
}
