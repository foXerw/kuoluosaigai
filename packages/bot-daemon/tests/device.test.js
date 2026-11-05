import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceIdentity, deriveDeviceId } from '../device.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-device-id-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('createDeviceIdentity', () => {
  it('首启生成 64 hex 令牌并落盘，重载稳定', () => {
    const id = createDeviceIdentity({ dir })
    expect(id.token()).toMatch(/^[a-f0-9]{64}$/)
    expect(id.deviceId()).toBe(deriveDeviceId(id.token()))
    const doc = JSON.parse(fs.readFileSync(id.path, 'utf8'))
    expect(doc).toEqual({ version: 1, token: id.token() })
    expect(fs.existsSync(id.path + '.tmp')).toBe(false)

    const again = createDeviceIdentity({ dir })
    expect(again.token()).toBe(id.token())
    expect(again.deviceId()).toBe(id.deviceId())
  })

  it('坏文件/非法 token → 重新铸造（不崩）', () => {
    const file = path.join(dir, 'device.json')
    fs.writeFileSync(file, '{bad')
    const a = createDeviceIdentity({ dir })
    expect(a.token()).toMatch(/^[a-f0-9]{64}$/)

    fs.writeFileSync(file, JSON.stringify({ version: 1, token: 'A'.repeat(64) }))
    const b = createDeviceIdentity({ dir })
    expect(b.token()).not.toBe('A'.repeat(64))
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(b.token())
  })

  it('rotate 换 token/deviceId 并持久化；setToken 可回滚', () => {
    const id = createDeviceIdentity({ dir })
    const oldToken = id.token()
    const oldId = id.deviceId()
    const next = id.rotate()
    expect(next.token).not.toBe(oldToken)
    expect(next.deviceId).toBe(deriveDeviceId(next.token))
    expect(next.deviceId).not.toBe(oldId)
    expect(JSON.parse(fs.readFileSync(id.path, 'utf8')).token).toBe(next.token)

    id.setToken(oldToken)
    expect(id.token()).toBe(oldToken)
    expect(JSON.parse(fs.readFileSync(id.path, 'utf8')).token).toBe(oldToken)
  })

  it('rotate 落盘失败时内存回滚', () => {
    const id = createDeviceIdentity({ dir })
    const old = id.token()
    const real = fs.writeFileSync
    fs.writeFileSync = () => { throw new Error('EIO') }
    try {
      expect(() => id.rotate()).toThrow(/EIO/)
      expect(id.token()).toBe(old)
    } finally {
      fs.writeFileSync = real
    }
  })

  it('setToken 拒绝非法值（错误文本不含输入）', () => {
    const id = createDeviceIdentity({ dir })
    let msg = ''
    try {
      id.setToken('nope')
    } catch (e) {
      msg = e.message
    }
    expect(msg).toMatch(/token/i)
    expect(msg).not.toContain('nope')
  })

  it('deriveDeviceId 稳定且区分 token', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(deriveDeviceId(a)).toMatch(/^[a-f0-9]{16}$/)
    expect(deriveDeviceId(a)).toBe(deriveDeviceId(a))
    expect(deriveDeviceId(a)).not.toBe(deriveDeviceId(b))
  })
})
