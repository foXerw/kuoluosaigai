import { describe, it, expect, afterEach, afterAll } from 'vitest'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from './index.js'

// 真 server + 真 ws：验证 /device 分流不污染参与者面，以及 devices.json 跨重启。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-device-channel-'))
let seq = 0
const T1 = 'c'.repeat(64)

describe('server /device channel', () => {
  let server, url

  afterEach(async () => {
    if (server) await server.close()
    server = null
  })
  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  async function boot(extra = {}) {
    const id = seq++
    server = createServer({
      roomsFile: path.join(TMP_ROOT, `rooms-${id}.log`),
      devicesFile: path.join(TMP_ROOT, `devices-${id}.json`),
      ...extra,
    })
    const port = await server.start(0)
    url = `ws://localhost:${port}`
    return { devicesFile: path.join(TMP_ROOT, `devices-${id}.json`) }
  }

  function connect(pathname = '') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url + pathname)
      const received = []
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
      ws.on('error', reject)
      ws.on('open', () => resolve({ ws, received }))
    })
  }

  function nextFrame(received, timeout = 1500) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const timer = setTimeout(() => reject(new Error('frame timeout')), timeout)
      const check = () => {
        if (received.length) {
          clearTimeout(timer)
          resolve(received.shift())
        } else if (Date.now() - t0 > timeout) {
          clearTimeout(timer)
          reject(new Error('frame timeout'))
        } else {
          setTimeout(check, 5)
        }
      }
      check()
    })
  }

  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))
  const send = (c, frame) => c.ws.send(JSON.stringify(frame))

  it('/device 不发 assign；设备连接不占房间席位/在线数，也不广播 presence', async () => {
    await boot()
    const p = await connect()
    expect((await nextFrame(p.received)).type).toBe('assign')
    send(p, { type: 'join', roomId: 'setsubun' })
    expect((await nextFrame(p.received)).type).toBe('joined')

    const d = await connect('/device')
    await settle()
    expect(d.received).toEqual([]) // 没有 assign

    send(d, { t: 'dev-auth', role: 'daemon', token: T1, name: 'lab-vm' })
    expect(await nextFrame(d.received)).toMatchObject({ t: 'dev-auth-ok', role: 'daemon', paired: false })
    await settle()
    expect(p.received).toEqual([]) // 设备上线不会触发房间 presence

    send(p, { type: 'counts', roomIds: ['setsubun'] })
    expect(await nextFrame(p.received)).toMatchObject({ type: 'counts', counts: { setsubun: 1 } })
  })

  it('配对落盘；server 重启后浏览器仍可用旧 token/session 认证', async () => {
    const { devicesFile } = await boot()
    const daemon = await connect('/device')
    send(daemon, { t: 'dev-auth', role: 'daemon', token: T1, name: 'lab-vm' })
    await nextFrame(daemon.received)

    send(daemon, { t: 'pair-new' })
    const codeFrame = await nextFrame(daemon.received)
    expect(codeFrame.t).toBe('pair-code')

    const browser = await connect('/device')
    send(browser, { t: 'pair-claim', code: codeFrame.code, label: 'Phone' })
    const ok = await nextFrame(browser.received)
    expect(ok).toMatchObject({ t: 'pair-ok', token: T1 })
    expect(ok.sessionId).toMatch(/^[a-f0-9]{16}$/)
    expect(fs.existsSync(devicesFile)).toBe(true)

    await server.close()
    server = null
    await boot({ devicesFile })

    const again = await connect('/device')
    send(again, { t: 'dev-auth', role: 'browser', token: T1, sessionId: ok.sessionId })
    expect(await nextFrame(again.received)).toMatchObject({
      t: 'dev-auth-ok',
      role: 'browser',
      name: 'lab-vm',
    })
  })

  it('未知 token 的浏览器与坏 session 得到同一错误', async () => {
    await boot()
    const b = await connect('/device')
    send(b, { t: 'dev-auth', role: 'browser', token: T1, sessionId: '0'.repeat(16) })
    expect(await nextFrame(b.received)).toEqual({ t: 'dev-auth-err' })
  })
})
