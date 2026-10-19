import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createRegistry, genRoomId } from './rooms.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 统一生产服务：同进程托管 dist/ 静态前端；可用 KUO_DIST_DIR 覆盖（测试用）
const DIST_DIR = process.env.KUO_DIST_DIR
  ? path.resolve(process.env.KUO_DIST_DIR)
  : path.resolve(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// 极简静态文件服务：根/未知路径回退 index.html（SPA），无新依赖
function serveStatic(req, res) {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Front-end not built. Run `npm run build` first.')
    return
  }
  const reqUrl = new URL(req.url, 'http://localhost')
  // WHATWG URL 已把 `..`（含 %2e%2e）归一化掉，rel 不会逃出 DIST_DIR
  const rel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '')
  const filePath = path.resolve(DIST_DIR, rel)
  // 根路径 / 不存在 / 目录 → SPA 回退 index.html
  let target = filePath
  if (!rel || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    target = path.join(DIST_DIR, 'index.html')
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const ext = path.extname(target).toLowerCase()
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(target).pipe(res)
}

const NICK_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 剔除 O/I/0/1
const MAX_LEN = 280
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000
const HEARTBEAT_MS = 30_000 // 保活 ping 间隔；低于多数 NAT/代理的空闲超时

function genNick() {
  let s = 'ANON-'
  for (let i = 0; i < 4; i++) {
    s += NICK_CHARS[Math.floor(Math.random() * NICK_CHARS.length)]
  }
  return s
}

const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/ // 与 NICK_CHARS 字符集一致（剔除 O/I/0/1）

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

// 消息 id 的进程级随机前缀（4 位 [a-z0-9]）：防服务器重启后新旧消息 id 相撞
function genBootToken() {
  let s = ''
  for (let i = 0; i < 4; i++) {
    s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  }
  return s
}
function isValidNick(n) {
  return typeof n === 'string' && NICK_RE.test(n)
}

function now() {
  return Date.now()
}

function noop() {}

// 心跳扫描纯函数：isAlive=false 的连接判为死链终止；其余置 false 并 ping（客户端自动回 pong 重置 isAlive）
export function sweepClients(clients) {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping(noop)
  }
}

export function createServer(opts = {}) {
  const {
    // 默认路径按 __dirname 解析（不随进程 cwd 漂移），KUO_ROOMS_FILE 可覆盖
    roomsFile = process.env.KUO_ROOMS_FILE ?? path.resolve(__dirname, 'data', 'rooms.log'),
    roomCap = 100,
    // 以下护栏参数由 Task 3 接线：本任务只落默认值并记录滑动窗口（joinFails/creates），不做判定
    historyRespMax = 200,
    joinFailLimit = 10,
    createLimit = 5,
    countsBatchMax = 50,
  } = opts

  const httpServer = http.createServer(serveStatic)
  const wss = new WebSocketServer({ server: httpServer })
  const registry = createRegistry(roomsFile)
  const clients = new Map() // ws -> { connId, nick, roomId, times, joinFails, creates }
  const rooms = new Map() // roomId -> Set<ws>
  let connSeq = 0
  let msgSeq = 0
  const bootToken = genBootToken()

  function send(ws, frame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  function sendToRoom(roomId, frame, except = null) {
    const members = rooms.get(roomId)
    if (!members) return
    const data = JSON.stringify(frame)
    for (const ws of members) {
      if (ws === except || ws.readyState !== ws.OPEN) continue
      ws.send(data)
    }
  }

  function rateLimited(info) {
    const t = now()
    info.times = info.times.filter((x) => t - x < RATE_WINDOW)
    if (info.times.length >= RATE_LIMIT) return true
    info.times.push(t)
    return false
  }

  // 离开当前房（若有）：房内其余成员收 leave + presence
  function removeFromRoom(ws, info) {
    const roomId = info.roomId
    if (!roomId) return
    info.roomId = null
    const members = rooms.get(roomId)
    if (!members) return
    members.delete(ws)
    if (members.size === 0) {
      rooms.delete(roomId)
      return
    }
    sendToRoom(roomId, { type: 'leave', roomId, nick: info.nick, ts: now() }, ws)
    sendToRoom(roomId, { type: 'presence', roomId, online: members.size }, ws)
  }

  // join 是原子的「离开旧房 + 进入新房」（同 ID 重复 join 视为幂等，只回 joined 回执）
  function joinRoom(ws, info, roomId) {
    if (info.roomId === roomId) {
      const members = rooms.get(roomId)
      send(ws, {
        type: 'joined',
        roomId,
        online: members ? members.size : 0,
        selfId: info.connId,
      })
      return
    }
    if (!registry.has(roomId)) {
      info.joinFails.push(now()) // Task 3 节流用，此处仅记录
      send(ws, { type: 'join-error', roomId, reason: 'unknown' })
      return
    }
    let members = rooms.get(roomId)
    if (!members) {
      members = new Set()
      rooms.set(roomId, members)
    }
    if (members.size >= roomCap) {
      send(ws, { type: 'join-error', roomId, reason: 'full' })
      return
    }
    removeFromRoom(ws, info)
    info.roomId = roomId
    members.add(ws)
    sendToRoom(roomId, { type: 'join', roomId, nick: info.nick, ts: now() }, ws)
    sendToRoom(roomId, { type: 'presence', roomId, online: members.size }, ws)
    send(ws, { type: 'joined', roomId, online: members.size, selfId: info.connId })
  }

  function createRoom(ws, info) {
    info.creates.push(now()) // Task 3 限速用，此处仅记录
    let roomId = genRoomId()
    while (registry.has(roomId)) roomId = genRoomId()
    registry.add(roomId)
    send(ws, { type: 'created', roomId })
    joinRoom(ws, info, roomId)
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })
    const requested = new URL(req.url, 'http://localhost').searchParams.get('nick')
    const nick = isValidNick(requested) ? requested : genNick()
    const info = {
      connId: ++connSeq,
      nick,
      roomId: null,
      times: [],
      joinFails: [],
      creates: [],
    }
    clients.set(ws, info)

    send(ws, { type: 'assign', nick })

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        send(ws, { type: 'error', msg: 'bad frame' })
        return
      }
      switch (frame.type) {
        case 'join':
          joinRoom(ws, info, String(frame.roomId ?? ''))
          break
        case 'create':
          createRoom(ws, info)
          break
        case 'message': {
          if (!info.roomId) {
            send(ws, { type: 'error', msg: 'not in room' })
            break
          }
          if (rateLimited(info)) {
            send(ws, { type: 'rate', ts: now() })
            break
          }
          const text = String(frame.text || '').slice(0, MAX_LEN)
          const id = bootToken + (++msgSeq).toString(36)
          sendToRoom(info.roomId, {
            type: 'message',
            id,
            ts: now(),
            roomId: info.roomId,
            nick: info.nick,
            badge: String(frame.badge || ''),
            text,
          })
          break
        }
        default:
          // history-req / history-res / counts（Task 3 接线）及未知帧：静默忽略（与 v1 一致）
          break
      }
    })

    ws.on('close', () => {
      if (!clients.delete(ws)) return
      removeFromRoom(ws, info)
    })

    ws.on('error', () => {
      // swallow; the 'close' handler cleans up the maps and broadcasts leave/presence
    })
  })

  wss.on('error', () => {
    // swallow server-level socket errors
  })

  // 保活心跳：每 HEARTBEAT_MS 扫描，无 pong 回应的死链被 terminate（触发 close → 清理 clients/rooms）
  const heartbeat = setInterval(() => sweepClients(wss.clients), HEARTBEAT_MS)

  return {
    start(port = 0) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => resolve(httpServer.address().port))
      })
    },
    close() {
      return new Promise((resolve) => {
        clearInterval(heartbeat)
        for (const ws of clients.keys()) ws.close()
        clients.clear()
        rooms.clear()
        wss.close(() => httpServer.close(() => resolve()))
      })
    },
  }
}
