import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// KUO_DIST_DIR 在 index.js 模块加载时读取，故在 beforeAll 里先设环境再动态 import；
// 动态 import 会被缓存，所以整组用例共享同一个 dist 目录与 server。
describe('static serving', () => {
  let dir, server, port

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-dist-'))
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><title>KUO</title><!-- MARK-XYZ -->',
    )
    fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg></svg>')
    process.env.KUO_DIST_DIR = dir
    const { createServer } = await import('./index.js')
    server = createServer()
    port = await server.start(0)
  })

  afterAll(async () => {
    if (server) await server.close()
    delete process.env.KUO_DIST_DIR
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  function get(reqPath) {
    return new Promise((resolve, reject) => {
      const req = http.get({ port, path: reqPath }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (body += d))
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'], body }),
        )
      })
      req.on('error', reject)
    })
  }

  it('serves index.html at /', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
    expect(r.body).toContain('MARK-XYZ')
  })

  it('falls back to index.html for unknown paths (SPA)', async () => {
    const r = await get('/no-such-route')
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
    expect(r.body).toContain('MARK-XYZ')
  })

  it('serves a real asset with the right mime type', async () => {
    const r = await get('/logo.svg')
    expect(r.status).toBe(200)
    expect(r.type).toContain('image/svg+xml')
    expect(r.body).toContain('<svg>')
  })
})
