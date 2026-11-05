// P3a：设备令牌与 server/data/devices.json 持久化。
//
// 设计钉死（spec §11 / §16.5 Q4、Q8、Q12）：
// - 令牌 = 64 位小写 hex（32 字节随机）；deviceId = sha256(token) 前 16 hex（R30）。
// - 磁盘**只存 sha256(token)**，不存明文；明文只在 daemon 首次 dev-auth 的内存连接里
//   短暂存在，用于 pair-ok 返回给浏览器（§11.6 已披露中继可见控制面）。
// - 这是聊天服务器的**第二处落盘**（第一处是 rooms.log）：设备身份 + 已配对会话。
//   坏文件 fail-closed 为空表（宁要求重新配对，不可放行未知 token）。
// - 同步读写 + tmp/rename，与 rooms 注册表同款；写失败向上抛，由 relay 记错误帧，不崩服务。
// - 未知 token / 未知 session 一律由上层回同一错误——本模块只做形状校验。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEVICES_VERSION = 1
export const TOKEN_RE = /^[a-f0-9]{64}$/
const PAIR_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 剔除 I/O/0/1
const MAX_NAME = 64
const MAX_LABEL = 32
const MAX_SESSION_ID = 64

export function isValidToken(v) {
  return typeof v === 'string' && TOKEN_RE.test(v)
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export function deriveDeviceId(token) {
  return hashToken(token).slice(0, 16)
}

export function genSessionId() {
  return crypto.randomBytes(8).toString('hex') // 16 hex
}

export function genPairCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += PAIR_CHARS[crypto.randomInt(0, PAIR_CHARS.length)]
  return s
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function cleanName(v) {
  return typeof v === 'string' ? v.slice(0, MAX_NAME) : ''
}

function cleanCreatedAt(v) {
  return Number.isFinite(v) ? v : 0
}

function cleanSessions(v) {
  const out = {}
  if (!isObject(v)) return out
  for (const [id, s] of Object.entries(v)) {
    if (typeof id !== 'string' || !id || id.length > MAX_SESSION_ID) continue
    if (!isObject(s)) continue
    const createdAt = Number(s.createdAt)
    if (!Number.isFinite(createdAt)) continue
    out[id] = { label: cleanName(s.label).slice(0, MAX_LABEL), createdAt }
  }
  return out
}

/** 严格净化（写路径）：tokenHash 非法是编程错误 → TypeError。 */
function sanitizeDevice(deviceId, d) {
  if (!isObject(d) || typeof d.tokenHash !== 'string' || !TOKEN_RE.test(d.tokenHash)) {
    throw new TypeError('devices: invalid tokenHash')
  }
  return {
    deviceId,
    tokenHash: d.tokenHash,
    name: cleanName(d.name),
    createdAt: cleanCreatedAt(d.createdAt),
    sessions: cleanSessions(d.sessions),
  }
}

/** 宽松净化（读路径）：任何坏条目直接丢弃，绝不抛。 */
function sanitizeDoc(doc) {
  const out = { version: DEVICES_VERSION, devices: {} }
  if (!isObject(doc) || !isObject(doc.devices)) return out
  for (const [deviceId, d] of Object.entries(doc.devices)) {
    if (!isObject(d) || typeof d.tokenHash !== 'string' || !TOKEN_RE.test(d.tokenHash)) continue
    out.devices[deviceId] = {
      deviceId,
      tokenHash: d.tokenHash,
      name: cleanName(d.name),
      createdAt: cleanCreatedAt(d.createdAt),
      sessions: cleanSessions(d.sessions),
    }
  }
  return out
}

function readDoc(file) {
  try {
    return sanitizeDoc(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    // 缺文件 / 坏 JSON / IO 失败统一为空表：不崩、不猜
    return sanitizeDoc(null)
  }
}

function cloneDevice(d) {
  if (!d) return null
  return { ...d, sessions: { ...d.sessions } }
}

/**
 * 设备表存储。
 * @param {{ file: string }} options
 * @returns {{ path: string, list: Function, get: Function, findByToken: Function,
 *   upsert: Function, remove: Function }}
 */
export function createDeviceStore({ file }) {
  let doc = readDoc(file)

  function persist() {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp'
    let moved = false
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
      fs.renameSync(tmp, file)
      moved = true
    } finally {
      if (!moved) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch (e) {
          /* 尽力清理，不掩盖原始异常 */
        }
      }
    }
  }

  return {
    path: file,
    list() {
      return Object.values(doc.devices).map(cloneDevice)
    },
    get(deviceId) {
      return cloneDevice(doc.devices[deviceId])
    },
    findByToken(token) {
      if (!isValidToken(token)) return null
      const h = hashToken(token)
      for (const d of Object.values(doc.devices)) {
        if (d.tokenHash === h) return cloneDevice(d)
      }
      return null
    },
    upsert(deviceId, device) {
      if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('devices: invalid deviceId')
      doc.devices[deviceId] = sanitizeDevice(deviceId, device)
      persist()
      return cloneDevice(doc.devices[deviceId])
    },
    remove(deviceId) {
      if (!doc.devices[deviceId]) return false
      delete doc.devices[deviceId]
      persist()
      return true
    },
  }
}
