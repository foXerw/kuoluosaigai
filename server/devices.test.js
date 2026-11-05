import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isValidToken,
  hashToken,
  deriveDeviceId,
  genSessionId,
  genPairCode,
  createDeviceStore,
} from './devices.js'

const T1 = 'a'.repeat(64)
const T2 = 'b'.repeat(64)

let tmpDir
let file

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-devices-'))
  file = path.join(tmpDir, 'devices.json')
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('token helpers', () => {
  it('64 位小写 hex 才是合法 token', () => {
    expect(isValidToken(T1)).toBe(true)
    expect(isValidToken('A'.repeat(64))).toBe(false)
    expect(isValidToken('a'.repeat(63))).toBe(false)
    expect(isValidToken('a'.repeat(65))).toBe(false)
    expect(isValidToken(null)).toBe(false)
    expect(isValidToken(123)).toBe(false)
  })

  it('deviceId = sha256(token) 前 16 hex，稳定且区分 token', () => {
    expect(hashToken(T1)).toMatch(/^[a-f0-9]{64}$/)
    expect(deriveDeviceId(T1)).toBe(hashToken(T1).slice(0, 16))
    expect(deriveDeviceId(T1)).toBe(deriveDeviceId(T1))
    expect(deriveDeviceId(T2)).not.toBe(deriveDeviceId(T1))
  })

  it('配对码 6 位、会话 id 16 hex', () => {
    for (let i = 0; i < 50; i++) expect(genPairCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(genSessionId()).toMatch(/^[a-f0-9]{16}$/)
  })
})

describe('createDeviceStore', () => {
  const device = (over = {}) => ({
    deviceId: deriveDeviceId(T1),
    tokenHash: hashToken(T1),
    name: 'lab-vm',
    createdAt: 100,
    sessions: { s1: { label: 'PC', createdAt: 200 } },
    ...over,
  })

  it('upsert → get/findByToken/list，重载后仍在', () => {
    const store = createDeviceStore({ file })
    const d = device()
    store.upsert(d.deviceId, d)
    expect(store.get(d.deviceId)).toEqual(d)
    expect(store.findByToken(T1)).toEqual(d)
    expect(store.findByToken(T2)).toBe(null)
    expect(store.list()).toEqual([d])

    const reopened = createDeviceStore({ file })
    expect(reopened.get(d.deviceId)).toEqual(d)
    expect(reopened.findByToken(T1)).toEqual(d)
    expect(fs.existsSync(file + '.tmp')).toBe(false)
  })

  it('坏文件/错形状 fail-closed 为空表且不抛', () => {
    fs.writeFileSync(file, '{not json')
    const a = createDeviceStore({ file })
    expect(a.list()).toEqual([])
    expect(a.get('x')).toBe(null)

    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [] }))
    const b = createDeviceStore({ file })
    expect(b.list()).toEqual([])
  })

  it('remove 持久化删除', () => {
    const store = createDeviceStore({ file })
    const d = device()
    store.upsert(d.deviceId, d)
    store.remove(d.deviceId)
    expect(store.get(d.deviceId)).toBe(null)
    expect(createDeviceStore({ file }).get(d.deviceId)).toBe(null)
  })

  it('清洗：label ≤32、非法 session 丢弃、deviceId 以键为准', () => {
    const store = createDeviceStore({ file })
    const d = device({
      deviceId: 'spoofed',
      name: 'x'.repeat(100),
      sessions: {
        ok: { label: 'y'.repeat(50), createdAt: 5 },
        bad: 'nope',
        alsoBad: { label: 'z', createdAt: 'later' },
      },
    })
    store.upsert(d.deviceId, d)
    const got = store.get(d.deviceId)
    expect(got.deviceId).toBe(d.deviceId)
    expect(got.name.length).toBe(64)
    expect(got.sessions.ok.label.length).toBe(32)
    expect(Object.keys(got.sessions)).toEqual(['ok'])
  })

  it('非法 tokenHash 是编程错误：抛出且不落盘', () => {
    const store = createDeviceStore({ file })
    expect(() => store.upsert('d', { tokenHash: 'nope', name: 'x', sessions: {} })).toThrow(TypeError)
    expect(fs.existsSync(file)).toBe(false)
  })
})
