// @vitest-environment node
// P0 验收 e2e（Task 6 / 修正案 R15）：替换原「手工浏览器冒烟」中可自动化的部分。
// 单个 Node 进程内起真实 server/（临时端口 + KUO_ROOMS_FILE 指临时目录，绝不碰
// server/data/），用包名 'kuoluosaigai-bot-core' 引入公开面，经 createBotConnection
// 以 globalThis.WebSocket（Node 24 原生实现——正是 P1 daemon 的处境）连入公共房，
// 走真实协议双向收发帧。无 LLM 调用：连接与协议层为限。
// 刻意作为常驻测试保留：这是「core 在浏览器之外可用」的可重复证据，不是一次性冒烟。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../server/index.js'
import { createBotConnection, CONFIG_KEY } from 'kuoluosaigai-bot-core'

// 服务端注册的公共房种子（server/rooms.js PUBLIC_ROOM_IDS）
const PUBLIC_ROOM = 'setsubun'
const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/

function mkCollector() {
  const frames = []
  return {
    frames,
    push: (f) => frames.push(f),
    // 轮询等待匹配帧出现：协议帧到达顺序有保证但时序异步，轮询最抗 flake
    async until(pred, label, timeout = 5000) {
      const t0 = Date.now()
      for (;;) {
        const hit = frames.find(pred)
        if (hit) {
          frames.splice(frames.indexOf(hit), 1)
          return hit
        }
        if (Date.now() - t0 > timeout) throw new Error(`超时未见帧：${label}`)
        await new Promise((r) => setTimeout(r, 10))
      }
    },
  }
}

describe('bot-core 纯 Node 端到端（真 server + 原生 WebSocket）', () => {
  let server
  let url
  let tmpDir
  let prevRoomsFile
  let botConn = null
  let observer = null

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-e2e-'))
    // 修正案 R15：走文档化环境变量把注册表指进临时目录（daemon 同款启动契约）
    prevRoomsFile = process.env.KUO_ROOMS_FILE
    process.env.KUO_ROOMS_FILE = path.join(tmpDir, 'rooms.log')
    server = createServer()
    const port = await server.start(0) // 临时端口，避免与并行进程撞车
    url = `ws://127.0.0.1:${port}`
  })

  afterAll(async () => {
    // 先关客户端再关服务端：顺序颠倒会让 conn.onclose 排 1s 退避重连定时器（悬挂句柄）
    if (botConn) botConn.close()
    if (observer && observer.readyState <= 1) observer.close()
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    // 终审 M6：还原 KUO_ROOMS_FILE——同进程后续测试不得继承本用例的临时目录指向
    if (prevRoomsFile === undefined) delete process.env.KUO_ROOMS_FILE
    else process.env.KUO_ROOMS_FILE = prevRoomsFile
  })

  it('包公开面在纯 Node（非 jsdom）下可具名导入且常量完好', () => {
    expect(typeof createBotConnection).toBe('function')
    expect(CONFIG_KEY).toBe('kuoluosaigai:bots:v1')
  })

  it(
    'core 连接以原生 WebSocket 入公共房，与真人视角观察者双向收发协议帧',
    async () => {
      const botFrames = mkCollector()
      const statuses = []
      botConn = createBotConnection({
        url,
        WebSocketImpl: globalThis.WebSocket, // P1 daemon 的真实注入形态
        onFrame: botFrames.push,
        onStatus: (s) => statuses.push(s),
      })

      // —— 真人视角观察者先入座：bot 的入房广播才有收件人 ——
      const obsFrames = mkCollector()
      observer = new globalThis.WebSocket(url)
      observer.addEventListener('message', (ev) => obsFrames.push(JSON.parse(ev.data)))
      await new Promise((resolve, reject) => {
        observer.addEventListener('open', resolve, { once: true })
        observer.addEventListener('error', () => reject(new Error('观察者连接失败')), { once: true })
      })
      observer.send(JSON.stringify({ type: 'join', roomId: PUBLIC_ROOM }))
      await obsFrames.until((f) => f.type === 'joined' && f.roomId === PUBLIC_ROOM, '观察者 joined')

      // —— 方向 1：server → bot ——
      botConn.connect(PUBLIC_ROOM)
      const assign = await botFrames.until((f) => f.type === 'assign', 'assign')
      expect(assign.nick).toMatch(NICK_RE)
      const joined = await botFrames.until(
        (f) => f.type === 'joined' && f.roomId === PUBLIC_ROOM,
        'joined'
      )
      expect(joined.selfId).toBeGreaterThan(0)
      expect(statuses).toContain('open')
      expect(botConn.currentRoomId).toBe(PUBLIC_ROOM)

      // —— 方向 2：bot → server → 观察者 ——
      // bot 的 join 本身已是「bot 上行帧被服务端转发」的证据
      const joinBroadcast = await obsFrames.until(
        (f) => f.type === 'join' && f.roomId === PUBLIC_ROOM,
        'bot 入房广播'
      )
      expect(joinBroadcast.nick).toBe(assign.nick)

      const chatText = 'P0-e2e：core 经原生 WebSocket 上房'
      expect(botConn.send({ type: 'message', text: chatText, badge: 'SETSUBUN' })).toBe(true)
      const botMsg = await obsFrames.until(
        (f) => f.type === 'message' && f.text === chatText,
        'bot 发言到达观察者'
      )
      expect(botMsg.nick).toBe(assign.nick)
      expect(botMsg.roomId).toBe(PUBLIC_ROOM)

      // —— 方向 3：观察者 → server → bot（bot 侧入站解码由 connection.js 完成）——
      observer.send(JSON.stringify({ type: 'message', text: '来自真人观察者的问候' }))
      const inbound = await botFrames.until(
        (f) => f.type === 'message' && f.text === '来自真人观察者的问候',
        '观察者发言到达 bot'
      )
      expect(inbound.roomId).toBe(PUBLIC_ROOM)

      // —— 干净收尾：close 后状态归 closed 且不再排重连 ——
      botConn.close()
      expect(statuses[statuses.length - 1]).toBe('closed')
      expect(botConn.send({ type: 'message', text: 'late' })).toBe(false)
    },
    20000
  )
})
