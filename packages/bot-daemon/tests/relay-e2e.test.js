// @vitest-environment node
// P3b 契约测试：真 daemon relay-client ⇄ 真 P3a /device 服务端。
// daemon 单测用 StubSocket、服务端单测用裸 ws；这里补上「两端帧形状互相对得上」的证据。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../server/index.js'
import { createRelayClient } from '../relay-client.js'

const T1 = 'a'.repeat(64)
let tmpDir
let server
let url

async function until(fn, label, timeout = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('timeout: ' + label)
    await new Promise((r) => setTimeout(r, 15))
  }
}

function openWs(target, frames) {
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(target)
    ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data)))
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('ws error')))
  })
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-p3b-e2e-'))
  server = createServer({
    roomsFile: path.join(tmpDir, 'rooms.log'),
    devicesFile: path.join(tmpDir, 'devices.json'),
  })
  const port = await server.start(0)
  url = `ws://127.0.0.1:${port}`
})

afterAll(async () => {
  if (server) await server.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('relay-client ⇄ /device 真服务端', () => {
  it('auth → pair → claim → paired → state → cmd/res 全链路', async () => {
    const commands = []
    let pairedFrame = null
    const client = createRelayClient({
      url,
      token: T1,
      name: 'lab-vm',
      WebSocketImpl: globalThis.WebSocket,
      onCommand: (f) => { commands.push(f); return { ok: true } },
      onPaired: (f) => { pairedFrame = f },
    })
    client.start()
    try {
      await until(() => client.isOpen(), 'daemon auth')
      expect(client.paired()).toBe(false)

      const codePromise = client.requestPair()
      const code = (await codePromise).code
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)

      const browserFrames = []
      const browser = await openWs(url + '/device', browserFrames)
      browser.send(JSON.stringify({ t: 'pair-claim', code, label: 'Phone' }))
      const ok = await until(() => browserFrames.find((f) => f.t === 'pair-ok'), 'pair-ok')
      expect(ok.token).not.toBe(T1) // 浏览器只拿 session 凭证

      await until(() => client.paired(), 'daemon paired')
      expect(pairedFrame).toMatchObject({ deviceId: ok.deviceId })

      client.pushState({ bots: [{ id: 'lixiao' }] })
      const state = await until(() => browserFrames.find((f) => f.t === 'dev-state'), 'dev-state')
      expect(state.state).toEqual({ bots: [{ id: 'lixiao' }] })

      browser.send(JSON.stringify({ t: 'dev-cmd', id: 'c1', cmd: 'deck.get', args: {} }))
      const cmd = await until(() => commands[0], 'daemon command')
      expect(cmd).toMatchObject({ id: 'c1', cmd: 'deck.get' })
      const res = await until(() => browserFrames.find((f) => f.t === 'dev-res'), 'dev-res')
      expect(res).toEqual({ t: 'dev-res', id: 'c1', ok: true, err: null })

      browser.close()
    } finally {
      client.stop()
    }
  })
})
