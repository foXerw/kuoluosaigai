import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createRegistry, genRoomId } from './rooms.js'
import { createDeviceStore } from './devices.js'
import { createRelay } from './relay.js'

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
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' }
  // HTML 壳（含 SPA 回退）不缓存：发版后旧壳引用已删除的 hash 资源会白屏。
  if (ext === '.html') headers['cache-control'] = 'no-cache'
  res.writeHead(200, headers)
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
    s += NICK_CHARS[crypto.randomInt(0, NICK_CHARS.length)]
  }
  return s
}

const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/ // 与 NICK_CHARS 字符集一致（剔除 O/I/0/1）

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

// 消息 id 的进程级随机前缀（4 位 [a-z0-9]）：防服务器重启后新旧消息 id 相撞
function genBootToken() {
  let s = ''
  for (let i = 0; i < 4; i++) {
    s += ID_CHARS[crypto.randomInt(0, ID_CHARS.length)]
  }
  return s
}
function isValidNick(n) {
  return typeof n === 'string' && NICK_RE.test(n)
}

function now() {
  return Date.now()
}

// 不可信字段只接受字符串：`String({toString: 123})` 会抛 TypeError，
// 未认证帧 × 一个恶意对象就能打崩整个进程。非字符串一律当空值/非法值。
function asStr(v, max = Infinity) {
  if (typeof v !== 'string') return ''
  return Number.isFinite(max) ? v.slice(0, max) : v
}

/** P3：设备路径与参与者路径在同一端口上分流；不新增端口/证书。 */
function isDevicePath(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname === '/device'
  } catch (e) {
    return false
  }
}

/**
 * 配对限速键（Q8）：CF Tunnel 后面源站看到的 remoteAddress 永远是 cloudflared，
 * 故优先 CF-Connecting-IP。**前提是源站端口不对公网开放**（见部署文档）；否则该头可伪造。
 */
function clientIp(req) {
  const raw = req.headers['cf-connecting-ip']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v === 'string' && v) return v.slice(0, 64)
  const addr = req.socket && req.socket.remoteAddress
  return typeof addr === 'string' && addr ? addr.slice(0, 64) : 'unknown'
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
    // P3：设备身份/配对会话的第二处落盘；KUO_DEVICES_FILE 可覆盖（测试必用临时文件）
    devicesFile = process.env.KUO_DEVICES_FILE ?? path.resolve(__dirname, 'data', 'devices.json'),
    relayOpts = {}, // 测试接缝：限速/上限可调
    roomCap = 100,
    historyRespMax = 200,
    historyReplyCap = 3, // history-req 最多投给几个同房成员（P2P 合并只需 ≥2 佐证）
    historyResLimit = 30, // 每连接 60s 内最多中继 30 份 history-res（防同房灌帧）
    joinFailLimit = 10,
    createLimit = 5,
    globalCreateLimit = 30, // 服务端级：所有连接合计 30 次/60s（防分布式刷注册表）
    countsBatchMax = 50,
    switchLimit = 20, // 切房成功节流：每连接 60s 窗内「换房成功的 join」封顶（首次落地计入；幂等重进与失败帧不计）
  } = opts

  const httpServer = http.createServer(serveStatic)
  // maxPayload=256KiB（R8）：入站帧字节帽必须容下协议自身合法最坏帧——
  // historyRespMax 200 × MAX_LEN 280 的 CJK history-res 上线 ≈184KB（UTF-8）再含信封；
  // 同时把 ws 默认 100MiB 的杀伤面（单条超大帧强制 ~100MiB 接收缓冲 + JSON.parse）收紧 400 倍。
  // 后续精化方向：解析后逐帧软弃（先验条数/字节再 JSON.parse），本轮不做。
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 })
  const registry = createRegistry(roomsFile)
  // P3 设备通道：/device 路径专用；与参与者协议完全隔离（不占房、不计在线、不进历史）。
  const deviceStore = createDeviceStore({ file: devicesFile })
  const relay = createRelay({
    store: deviceStore,
    send: (ws, frame) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
      } catch (e) {
        /* 单连接发送失败不拖垮中继 */
      }
    },
    ...relayOpts,
  })
  const clients = new Map() // ws -> { connId, nick, roomId, times, joinFails, creates, switches }
  const rooms = new Map() // roomId -> Set<ws>
  const byConnId = new Map() // selfId(connId) -> ws：history-res 点对点路由用，入房登记、断连删除
  const globalCreates = [] // 服务端级建房滑窗（跨连接）
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

  // 有上限的房内广播：历史请求只需要少数佐证者，避免入房人数 × 响应者数的 O(N²) 风暴。
  // 选人按 Set 插入顺序取前 N（最早入房者最可能有缓存）；热门房里这会让同一批人
  // 反复应答，后续若成为瓶颈可换轮转/随机起点。
  function sendToRoomLimited(roomId, frame, except, limit) {
    const members = rooms.get(roomId)
    if (!members) return
    // 0 / Infinity / 非有限数 = 不限制（bench 的 --history-cap 0 语义）；负数钳到 1。
    const max = limit === 0 || !Number.isFinite(limit)
      ? members.size
      : Math.max(1, Math.floor(limit))
    const data = JSON.stringify(frame)
    let sent = 0
    for (const ws of members) {
      if (ws === except || ws.readyState !== ws.OPEN) continue
      ws.send(data)
      sent += 1
      if (sent >= max) break
    }
  }

  function rateLimited(info) {
    const t = now()
    info.times = info.times.filter((x) => t - x < RATE_WINDOW)
    if (info.times.length >= RATE_LIMIT) return true
    info.times.push(t)
    return false
  }

  // 反脚本滑窗判定：60s 内事件（unknown 失败 / 建房）达到 limit 次即饱和；剪枝就地回写
  function windowSaturated(events, limit) {
    const t = now()
    const kept = events.filter((x) => t - x < RATE_WINDOW)
    events.length = 0
    events.push(...kept)
    return kept.length >= limit
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
      info.joinFails.push(now()) // 计入滑窗；full 不走此分支、不计入
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
    info.switches.push(now()) // 成功入房计入切房窗（unknown/full/幂等重进路径都不走到这里）
    byConnId.set(info.connId, ws) // 入房登记，供 history-res 按 selfId 点对点路由
    sendToRoom(roomId, { type: 'join', roomId, nick: info.nick, ts: now() }, ws)
    sendToRoom(roomId, { type: 'presence', roomId, online: members.size }, ws)
    send(ws, { type: 'joined', roomId, online: members.size, selfId: info.connId })
  }

  function createRoom(ws, info) {
    info.creates.push(now()) // 滑窗内建房计数（判定在 message 处理器的闸门）
    let roomId = genRoomId()
    while (registry.has(roomId)) roomId = genRoomId()
    try {
      registry.add(roomId) // add 内部先写文件后入 Set：append 抛错时内存不会留下幽灵 ID
    } catch {
      // 注册表落盘失败（ENOSPC/EACCES/ENOENT…）：回错误帧、不入幻影房、进程照常服务
      send(ws, { type: 'error', msg: 'registry write failed' })
      return
    }
    send(ws, { type: 'created', roomId })
    joinRoom(ws, info, roomId)
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })

    // —— P3 设备通道：/device 不参与参与者协议（不发 assign、不进 clients/rooms） ——
    if (isDevicePath(req)) {
      const ip = clientIp(req)
      ws.on('message', (raw) => {
        let frame
        try {
          frame = JSON.parse(raw.toString())
        } catch (e) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', msg: 'bad frame' }))
          return
        }
        try {
          relay.handle(ws, frame, { ip })
        } catch (e) {
          // 设备帧同样宁可单帧失败，不许打崩进程
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', msg: 'bad frame' }))
        }
      })
      ws.on('close', () => relay.onClose(ws))
      ws.on('error', () => {
        /* close 负责清理 */
      })
      return
    }

    const requested = new URL(req.url, 'http://localhost').searchParams.get('nick')
    const nick = isValidNick(requested) ? requested : genNick()
    const info = {
      connId: ++connSeq,
      nick,
      roomId: null,
      times: [],
      joinFails: [],
      creates: [],
      historyRes: [], // history-res 中继滑窗（防同房灌帧）
      switches: [], // 切房成功时刻的滑窗（push 见 joinRoom 成功路径）
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
      // 任何一帧的畸形字段都不许逸出成进程级异常：单帧失败只回 error。
      try {
      switch (frame.type) {
        case 'join': {
          // 反探测闸门：unknown 失败饱和后，后续 join（哪怕合法 ID）一律 rate、不再查注册表
          if (windowSaturated(info.joinFails, joinFailLimit)) {
            send(ws, { type: 'rate', ts: now() })
            break
          }
          const roomId = asStr(frame.roomId)
          // 切房成功闸门：切房窗饱和后，换房型 join 一律 rate、不执行任何房间变更；
          // 幂等重进当前房不消耗预算（否则饱和后连 joined 回执都拿不到，重连语义被打破）
          if (roomId !== info.roomId && windowSaturated(info.switches, switchLimit)) {
            send(ws, { type: 'rate', ts: now() })
            break
          }
          joinRoom(ws, info, roomId)
          break
        }
        case 'create':
          if (windowSaturated(info.creates, createLimit)) {
            send(ws, { type: 'rate', ts: now() })
            break
          }
          // 全局闸：单连接各自 5 次挡不住分布式脚本，注册表是唯一落盘面。
          if (windowSaturated(globalCreates, globalCreateLimit)) {
            send(ws, { type: 'rate', ts: now() })
            break
          }
          globalCreates.push(now())
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
          const text = asStr(frame.text, MAX_LEN)
          const id = bootToken + (++msgSeq).toString(36)
          sendToRoom(info.roomId, {
            type: 'message',
            id,
            ts: now(),
            roomId: info.roomId,
            nick: info.nick,
            // 自报徽章不设上限等于让全房转发任意长串；按码点截，避免劈开 emoji
            badge: Array.from(asStr(frame.badge)).slice(0, 32).join(''),
            text,
          })
          break
        }
        case 'history-req': {
          // 只中继给同房其他人（except=ws 让请求者天然不收）；未入房无中继对象，静默丢弃
          if (!info.roomId) break
          sendToRoomLimited(
            info.roomId,
            { type: 'history-req', roomId: info.roomId, from: info.connId },
            ws,
            historyReplyCap
          )
          break
        }
        case 'history-res': {
          // 防跨房污染：发送者当前房 === 帧 roomId === 目标当前房，任一不符整帧丢弃
          const roomId = asStr(frame.roomId)
          const target = byConnId.get(frame.to)
          const tinfo = target ? clients.get(target) : null
          if (!tinfo || info.roomId !== roomId || tinfo.roomId !== roomId) break
          if (windowSaturated(info.historyRes, historyResLimit)) break
          const messages = Array.isArray(frame.messages)
            ? frame.messages.slice(-historyRespMax)
            : []
          info.historyRes.push(now())
          send(target, { type: 'history-res', roomId, from: info.connId, messages })
          break
        }
        case 'counts': {
          // 超批量静默截断；注册表内 ID 给在线数（可 0），未知 ID 键缺席
          const ids = Array.isArray(frame.roomIds)
            ? frame.roomIds.filter((id) => typeof id === 'string').slice(0, countsBatchMax)
            : []
          const counts = {}
          for (const id of ids) {
            if (!registry.has(id)) continue
            const members = rooms.get(id)
            counts[id] = members ? members.size : 0
          }
          send(ws, { type: 'counts', counts })
          break
        }
        default:
          // 未知帧：静默忽略（与 v1 一致）
          break
      }
      } catch (e) {
        send(ws, { type: 'error', msg: 'bad frame' })
      }
    })

    ws.on('close', () => {
      if (!clients.delete(ws)) return
      byConnId.delete(info.connId)
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
        // 参与者与设备连接都在 wss.clients：设备连接不在 clients Map 里，必须单独遍历。
        for (const ws of wss.clients) {
          relay.onClose(ws) // 对参与者是无害空操作（relay 只认识设备连接）
          try {
            ws.close()
          } catch (e) {
            /* 已关闭的连接忽略 */
          }
        }
        clients.clear()
        rooms.clear()
        byConnId.clear()
        wss.close(() => httpServer.close(() => resolve()))
      })
    },
  }
}
