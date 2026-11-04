// @vitest-environment node
// Task 10：本地控制面测试（Q12/A3/A1/A7 精神）。
// 钉死：只绑回环且端口由内核分配；rpc.json 在 listen 成功**之后**才落盘、close 必删（且
// 只删自家的）；缺/错 secret → 401 **同一响应体**（不给枚举 oracle）；未知路径 → 404 且
// **不**调 snapshot；超大请求体 → 413（控制口不当放大器）；snapshot 炸 → 500 固定体
// （A3：异常文本可能内嵌输入切片，绝不外泄）；响应零 key（A1）；readRpcFile 三态判定永不抛。
// 全部真绑 127.0.0.1:0（零真网超出回环）；临时目录在 os.tmpdir() 下、afterAll 守卫清理；
// 每个 handle 都在 finally 里 close（closeAllConnections 兜底，不留悬挂 socket）。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { RPC_FILE_NAME, SECRET_HEADER, randomHex, readRpcFile, startControlServer } from '../rpc.js'

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-rpc-test-'))
})
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

function snapshotFixture() {
  return {
    meta: {
      deviceId: null,
      name: 'lab-vm',
      uptimeMs: 60000,
      globalHourCount: null,
      restartRequired: false,
      generatedAt: 1730000000000,
    },
    bots: [
      {
        id: 'lixiao',
        name: '小李',
        room: 'nebula',
        status: 'running',
        nick: 'ANON-7C2D',
        hourCount: 3,
        session: { promptTokens: 100, completionTokens: 50, messages: 7 },
        lifetime: { promptTokens: 900, completionTokens: 300 },
      },
    ],
  }
}

// 裸 node:http 客户端：413 早断场景下也能可靠收到响应（控制面侧的协议判定不依赖具体
// HTTP 客户端实现对「服务端中途回绝」的脾气）。keepAlive:false 保证每个请求自带收口。
function rawRequest(port, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false })
    let settled = false
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method || 'GET', path: o.path || '/status', headers: o.headers || {}, agent },
      (res) => {
        settled = true
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => {
          agent.destroy()
          resolve({ status: res.statusCode, text, headers: res.headers })
        })
      },
    )
    req.on('error', (e) => {
      agent.destroy()
      if (!settled) {
        settled = true
        reject(e)
      }
    })
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

// 起服务器 → 跑 fn → 必 close。fn 里再手动 close 是合法的（幂等由实现保证）。
async function withServer(options, fn) {
  const dir = freshDir()
  let snapshotCalls = 0
  const snapshot =
    (options && options.snapshot) ||
    (() => {
      snapshotCalls += 1
      return snapshotFixture()
    })
  let handle = null
  try {
    handle = await startControlServer(Object.assign({ dir, snapshot }, options && options.server ? options.server : {}))
    return await fn(handle, dir, () => snapshotCalls)
  } finally {
    await handle.close()
  }
}

// —— 生命周期与 rpc.json 形状 ——

it('listen 成功后才落 rpc.json：{port,secret,pid,startedAt} 齐全、端口内核分配（>0 且等于 handle.port）、secret ≥32 位 hex', async () => {
  const dir = freshDir()
  const rpcPath = path.join(dir, RPC_FILE_NAME)
  expect(fs.existsSync(rpcPath)).toBe(false)
  const handle = await startControlServer({ dir, snapshot: () => snapshotFixture() })
  try {
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.rpcPath).toBe(rpcPath)
    const doc = JSON.parse(fs.readFileSync(rpcPath, 'utf8'))
    expect(doc.port).toBe(handle.port)
    expect(doc.pid).toBe(process.pid)
    expect(Number.isFinite(doc.startedAt)).toBe(true)
    expect(doc.secret).toMatch(/^[0-9a-f]{32,}$/) // 16 随机字节 = 32 hex 下限
    expect(doc.secret).toBe(handle.secret)
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/) // randomHex(16) 恰好 16 字节下限
  } finally {
    await handle.close()
  }
})

it('close() 后 rpc.json 被删除（不留指向死端口的陈旧文件）；随后请求快速 ECONNREFUSED（有界，不挂死）', async () => {
  const dir = freshDir()
  const rpcPath = path.join(dir, RPC_FILE_NAME)
  const handle = await startControlServer({ dir, snapshot: () => snapshotFixture() })
  const port = handle.port
  expect(fs.existsSync(rpcPath)).toBe(true)
  await handle.close()
  await handle.close() // 幂等：连击不抛
  expect(fs.existsSync(rpcPath)).toBe(false)
  await expect(rawRequest(port, {})).rejects.toThrow(/ECONNREFUSED/)
})

it('close() 只删**自家的** rpc.json（pid+port+secret 对账）：被继任者改写后不盲删（lock.release 同款纪律）', async () => {
  const dir = freshDir()
  const rpcPath = path.join(dir, RPC_FILE_NAME)
  const handle = await startControlServer({ dir, snapshot: () => snapshotFixture() })
  fs.writeFileSync(rpcPath, JSON.stringify({ port: 9999, secret: 'f'.repeat(32), pid: 424242, startedAt: 1 }) + '\n')
  await handle.close()
  expect(fs.existsSync(rpcPath)).toBe(true) // 内容不是我的 → 不碰
  fs.rmSync(rpcPath, { force: true })
})

it('拒绝绑非回环 host（A3：0.0.0.0 直接拒——不给「不小心开了对外口」留活路），且不落任何 rpc.json', async () => {
  const dir = freshDir()
  await expect(startControlServer({ dir, host: '0.0.0.0', snapshot: () => ({}) })).rejects.toThrow(/回环/)
  expect(fs.existsSync(path.join(dir, RPC_FILE_NAME))).toBe(false)
})

it('dir 落在普通文件上 → 写 rpc.json 必炸：startControlServer 有界失败（原样上抛），且不留指向死端口的文件', async () => {
  const dir = freshDir()
  const blockedDir = path.join(dir, 'not-a-dir')
  fs.writeFileSync(blockedDir, '我占着这个路径')
  await expect(startControlServer({ dir: blockedDir, snapshot: () => ({}) })).rejects.toBeTruthy()
  expect(fs.existsSync(blockedDir)).toBe(true)
  expect(fs.existsSync(path.join(blockedDir, RPC_FILE_NAME))).toBe(false)
})

// —— 鉴权（A7 精神）——

it('无 secret → 401；错 secret → 401：**同一状态码、同一响应体**（不给枚举 oracle），两者都不调 snapshot', async () => {
  await withServer({}, async (handle, dir, calls) => {
    const missing = await rawRequest(handle.port, { path: '/status' })
    const wrong = await rawRequest(handle.port, { path: '/status', headers: { [SECRET_HEADER]: 'deadbeef'.repeat(8) } })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(wrong.text).toBe(missing.text) // 逐字节一致
    expect(calls()).toBe(0)
    const good = await rawRequest(handle.port, { path: '/status', headers: { [SECRET_HEADER]: handle.secret } })
    expect(good.status).toBe(200)
    expect(calls()).toBe(1)
  })
})

// —— 路由（A3：只有一个只读端点）——

it('/status 返回 200 的 snapshot JSON；响应体里搜不到 apiKey 子串（A1 控制面侧）', async () => {
  await withServer({}, async (handle, dir, calls) => {
    const res = await rawRequest(handle.port, { headers: { [SECRET_HEADER]: handle.secret } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.text)).toEqual(snapshotFixture())
    expect(res.text).not.toContain('apiKey')
    expect(calls()).toBe(1)
  })
})

it('未知路径 → 404，且**不**调用 snapshot provider（A3：不给任意 URL 开口）', async () => {
  await withServer({}, async (handle, dir, calls) => {
    const res = await rawRequest(handle.port, { path: '/command', headers: { [SECRET_HEADER]: handle.secret } })
    expect(res.status).toBe(404)
    expect(calls()).toBe(0)
  })
})

it('非 GET 方法（哪怕带合法 secret）→ 405，不调 snapshot——控制面没有指令通道', async () => {
  await withServer({}, async (handle, dir, calls) => {
    const res = await rawRequest(handle.port, { method: 'POST', body: '{"cmd":"switch-room"}', headers: { [SECRET_HEADER]: handle.secret } })
    expect(res.status).toBe(405)
    expect(calls()).toBe(0)
  })
})

// —— 放大器防线 ——

it('超大请求体被拒（413）：readBodyLimit 生效、snapshot 不被调用、控制口事后仍健康（一次坏请求不许炸端口）', async () => {
  await withServer({ server: { readBodyLimit: 64 } }, async (handle, dir, calls) => {
    const big = 'A'.repeat(4096)
    const res = await rawRequest(handle.port, { method: 'POST', body: big, headers: { [SECRET_HEADER]: handle.secret } })
    expect(res.status).toBe(413)
    expect(calls()).toBe(0)
    const after = await rawRequest(handle.port, { headers: { [SECRET_HEADER]: handle.secret } })
    expect(after.status).toBe(200)
  })
})

// —— snapshot 炸的 A3 面 ——

it('snapshot 抛异常 → 500 固定响应体：异常文本（可能内嵌输入切片/key）绝不进响应（A3）', async () => {
  const boom = () => {
    throw new Error('internal leak window: sk-SUPERSECRETSLEETOP')
  }
  await withServer({ snapshot: boom }, async (handle) => {
    const res = await rawRequest(handle.port, { headers: { [SECRET_HEADER]: handle.secret } })
    expect(res.status).toBe(500)
    expect(res.text).not.toContain('sk-SUPERSE')
    expect(res.text).not.toContain('internal leak')
    expect(JSON.parse(res.text)).toEqual({ error: 'snapshot-unavailable' })
  })
})

it('snapshot 返回 JSON.stringify 炸得动的值（BigInt）→ 500 固定体、处理器活着（连续两次都答，不是 uncaughtException）——Important 2：序列化面也归请求路径的兜底', async () => {
  const bad = () => ({ big: 10n }) // BigInt 进 JSON.stringify 必 throw TypeError
  await withServer({ snapshot: bad }, async (handle) => {
    const first = await rawRequest(handle.port, { headers: { [SECRET_HEADER]: handle.secret } })
    expect(first.status).toBe(500)
    expect(JSON.parse(first.text)).toEqual({ error: 'snapshot-unavailable' })
    const second = await rawRequest(handle.port, { headers: { [SECRET_HEADER]: handle.secret } })
    expect(second.status).toBe(500) // 处理器没被第一次炸死——服务继续应答
  })
})

it('拒绝绑 ::1（Minor 3：allowlist 与 client 面一致——rpc.json 形状里没有 host 字段，v6 回环绑了 status 也够不着，不留半截协议）', async () => {
  const dir = freshDir()
  let err = null
  let handle = null
  try {
    handle = await startControlServer({ dir, host: '::1', snapshot: () => ({}) })
    err = null
  } catch (e) {
    err = e
  }
  if (handle) await handle.close() // 修复前（allowlist 还含 ::1）：此处红，且已把泄漏的监听收口
  expect(err !== null && /回环/.test(String(err.message))).toBe(true)
})

// —— readRpcFile（status 的三态判据原料）——

it('readRpcFile：缺文件→missing；坏 JSON/非法字段→malformed；EISDIR→unreadable——三态齐全、永不抛、不回显盘上内容', () => {
  const dir = freshDir()
  const missing = readRpcFile({ dir })
  expect(missing.ok).toBe(false)
  expect(missing.why).toBe('missing')
  expect(missing.path).toBe(path.join(dir, RPC_FILE_NAME))

  fs.writeFileSync(path.join(dir, RPC_FILE_NAME), '{这不是 JSON 而且带 sk-SUPERSE 切片')
  expect(readRpcFile({ dir }).why).toBe('malformed')

  fs.writeFileSync(path.join(dir, RPC_FILE_NAME), JSON.stringify({ port: 0, secret: 'a'.repeat(32), pid: 1, startedAt: 1 }))
  expect(readRpcFile({ dir }).why).toBe('malformed') // port 必须落在 1..65535

  fs.writeFileSync(path.join(dir, RPC_FILE_NAME), JSON.stringify({ port: 1234, secret: 'a'.repeat(31), pid: 1, startedAt: 1 }))
  expect(readRpcFile({ dir }).why).toBe('malformed') // secret 短于 32 位下限也拒

  fs.writeFileSync(path.join(dir, RPC_FILE_NAME), JSON.stringify({ port: 1234, secret: 'a'.repeat(32), pid: 0, startedAt: 1 }))
  expect(readRpcFile({ dir }).why).toBe('malformed') // pid 必须正整数

  const goodDoc = { port: 12345, secret: 'ab'.repeat(16), pid: 4242, startedAt: 1730000000000 }
  fs.writeFileSync(path.join(dir, RPC_FILE_NAME), JSON.stringify(goodDoc))
  const good = readRpcFile({ dir })
  expect(good.ok).toBe(true)
  expect(good.info).toEqual(goodDoc)

  const nested = freshDir()
  fs.mkdirSync(path.join(nested, RPC_FILE_NAME)) // 目录占位 → 读必 EISDIR
  expect(readRpcFile({ dir: nested }).ok).toBe(false)
  expect(readRpcFile({ dir: nested }).why).toBe('unreadable')
})
