// 可复现的服务端基准（本机回环，无真网/无外部依赖）。
//
// 两个场景：
//   A. 广播：N 个客户端同房，发 M 条消息，统计每条到达所有接收者的延迟 p50/p95。
//   B. 历史风暴：房内已有 H 条历史，J 个新客户端同时加入并发送 history-req，
//      统计 joined 用时、每个新客户端收到的 history-res 份数与总字节。
//
// 用法：
//   node scripts/bench-server.mjs [--clients 30] [--messages 100]
//                                 [--joiners 10] [--history 20]
//                                 [--history-cap 0]   # 0 = 不限制（基线）
// 数字只适合同机相对比较；不要拿它当公网容量承诺。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { createServer } from '../server/index.js'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

const CLIENTS = Math.max(2, arg('clients', 30))
const MESSAGES = Math.max(1, arg('messages', 100))
const JOINERS = Math.max(1, arg('joiners', 10))
const HISTORY = Math.max(1, arg('history', 20))
const HISTORY_CAP = Math.max(0, arg('history-cap', 0))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-bench-'))
const server = createServer({
  roomsFile: path.join(tmp, 'rooms.log'),
  devicesFile: path.join(tmp, 'devices.json'),
  historyReplyCap: HISTORY_CAP > 0 ? HISTORY_CAP : 1e9,
})
const port = await server.start(0)
const url = `ws://127.0.0.1:${port}`

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const frames = []
    const cache = [] // 模拟 useChat 的每房缓存：history-req 时据此回 history-res
    const size = { bytes: 0 }
    const state = { roomId: null, selfId: null }
    ws.on('message', (raw) => {
      size.bytes += raw.length
      let f
      try {
        f = JSON.parse(raw.toString())
      } catch (e) {
        return
      }
      frames.push(f)
      if (f.type === 'joined') {
        state.roomId = f.roomId
        state.selfId = f.selfId
      } else if (f.type === 'message') {
        cache.push({ id: f.id, ts: f.ts, roomId: f.roomId, nick: f.nick, badge: f.badge, text: f.text })
      } else if (f.type === 'history-req' && f.from !== state.selfId && cache.length) {
        ws.send(JSON.stringify({
          type: 'history-res',
          roomId: f.roomId,
          to: f.from,
          messages: cache.slice(-200),
        }))
      }
    })
    ws.on('open', () => resolve({ ws, frames, size, cache, state }))
    ws.on('error', reject)
  })
}

async function waitFor(pred, timeout = 5000, label = 'frame') {
  const t0 = performance.now()
  for (;;) {
    const v = pred()
    if (v) return v
    if (performance.now() - t0 > timeout) throw new Error('timeout: ' + label)
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function join(c, room = 'setsubun') {
  c.ws.send(JSON.stringify({ type: 'join', roomId: room }))
  return waitFor(() => c.frames.find((f) => f.type === 'joined'), 5000, 'joined')
}

function pct(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2)
}

const clients = []
try {
  for (let i = 0; i < CLIENTS; i++) clients.push(await connect())
  for (const c of clients) await join(c)
  for (const c of clients) c.frames.length = 0

  // A. 广播延迟
  // 服务端限速 10 条/60s/连接：用多个发送者（每人 ≤10 条）才能在窗口内压出并发广播。
  const senders = clients.slice(0, Math.max(1, Math.min(clients.length, Math.ceil(MESSAGES / 10))))
  const effectiveMessages = Math.min(MESSAGES, senders.length * 10)
  const receivers = clients
  const latencies = []
  const tA = performance.now()
  for (let i = 0; i < effectiveMessages; i++) {
    senders[i % senders.length].ws.send(JSON.stringify({
      type: 'message',
      text: `bench:${i}:${performance.now().toFixed(3)}`,
      badge: '',
    }))
  }
  if (effectiveMessages < MESSAGES) {
    console.error(`[bench] rate limit: reduced messages ${MESSAGES} -> ${effectiveMessages}`)
  }
  await waitFor(
    () => receivers.every((c) => c.frames.filter((f) => f.type === 'message').length >= effectiveMessages),
    20000,
    'broadcast',
  )
  const broadcastMs = performance.now() - tA
  // 收集只做一次，避免轮询重复计入
  for (const c of receivers) {
    for (const m of c.frames) {
      if (m.type !== 'message') continue
      const parts = String(m.text || '').split(':')
      if (parts[0] === 'bench' && parts[2]) latencies.push(performance.now() - Number(parts[2]))
    }
    c.frames.length = 0
  }

  // B. 历史风暴
  const room = 'nebula'
  const seed = []
  for (let i = 0; i < Math.min(CLIENTS, 10); i++) {
    const c = await connect()
    await join(c, room)
    c.frames.length = 0
    seed.push(c)
  }
  // 同样受 10 条/60s/连接：历史消息由 seed 客户端轮流发
  const seedCount = Math.min(HISTORY, seed.length * 10)
  for (let i = 0; i < seedCount; i++) {
    seed[i % seed.length].ws.send(JSON.stringify({ type: 'message', text: `history-${i}`, badge: '' }))
  }
  await waitFor(() => seed[0].frames.filter((f) => f.type === 'message').length >= seedCount, 10000, 'seed')
  for (const c of seed) c.frames.length = 0

  const joiners = []
  const tB = performance.now()
  for (let i = 0; i < JOINERS; i++) {
    const c = await connect()
    await waitFor(() => c.frames.find((f) => f.type === 'assign'), 5000, 'assign')
    c.frames.length = 0
    c.ws.send(JSON.stringify({ type: 'join', roomId: room }))
    joiners.push(c)
  }
  await waitFor(
    () => joiners.every((c) => c.frames.some((f) => f.type === 'joined' && f.online > 1)),
    10000,
    'joiners joined',
  )
  const joinedMs = performance.now() - tB
  for (const c of joiners) c.frames.length = 0
  // 模拟 useChat：joined 后请求历史
  for (const c of joiners) c.ws.send(JSON.stringify({ type: 'history-req' }))
  await new Promise((r) => setTimeout(r, 1500))

  const perJoiner = joiners.map((c) => ({
    responses: c.frames.filter((f) => f.type === 'history-res').length,
    bytes: c.size.bytes,
  }))
  const totalBytes = perJoiner.reduce((n, x) => n + x.bytes, 0)
  const avgResponses = perJoiner.reduce((n, x) => n + x.responses, 0) / joiners.length

  console.log(JSON.stringify({
    node: process.version,
    platform: `${os.platform()} ${os.arch()} / ${os.cpus().length} cores`,
    params: { clients: CLIENTS, messages: effectiveMessages, joiners: JOINERS, history: seedCount, historyCap: HISTORY_CAP || 'unlimited' },
    broadcast: {
      messages: effectiveMessages,
      receivers: receivers.length,
      msTotal: +broadcastMs.toFixed(1),
      latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: pct(latencies, 100) },
    },
    historyStorm: {
      joinedMs: +joinedMs.toFixed(1),
      avgResponsesPerJoiner: +avgResponses.toFixed(2),
      totalBytes,
      perJoiner,
    },
  }, null, 2))
} finally {
  for (const c of clients) c.ws.close()
  await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
