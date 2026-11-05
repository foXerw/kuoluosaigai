// P3b：daemon 的本地设备身份（spec Q4/R30）。
//
// - 首启在数据目录铸造 64 hex 设备令牌；跨重启稳定；`deviceId = sha256(token)[:16]`。
// - device.json 只存 token；原子 tmp+rename；0600 尽力而为（Windows 上 chmod 可能无效，
//   防线是数据目录本身的操作系统权限）。
// - 令牌不进日志、不进错误文本；调用方（host）只把它交给 /device 的 dev-auth。
// - 坏文件/缺失 → 重新铸造（等于重新配对，不崩 daemon）。rotate/setToken 落盘失败时
//   内存回滚，调用方不会拿到一个“以为已保存”的新令牌。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEVICE_FILE_NAME = 'device.json'
export const DEVICE_FILE_VERSION = 1
export const TOKEN_RE = /^[a-f0-9]{64}$/

export function deriveDeviceId(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, 16)
}

function readToken(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (doc && typeof doc.token === 'string' && TOKEN_RE.test(doc.token)) return doc.token
  } catch (e) {
    /* 缺文件/坏 JSON/IO 失败：重新铸造 */
  }
  return null
}

/**
 * @param {{ dir: string, fileName?: string }} opts
 * @returns {{ path: string, token: () => string, deviceId: () => string,
 *   rotate: () => {token: string, deviceId: string}, setToken: (t: string) => void }}
 */
export function createDeviceIdentity({ dir, fileName = DEVICE_FILE_NAME } = {}) {
  const file = path.join(dir, fileName)

  function persist(tok) {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp'
    let moved = false
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: DEVICE_FILE_VERSION, token: tok }) + '\n', { mode: 0o600 })
      try {
        fs.chmodSync(tmp, 0o600)
      } catch (e) {
        /* Windows 尽力而为 */
      }
      fs.renameSync(tmp, file)
      moved = true
    } finally {
      if (!moved) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch (e) {
          /* 不掩盖原始异常 */
        }
      }
    }
  }

  let token = readToken(file)
  if (token === null) {
    token = crypto.randomBytes(32).toString('hex')
    persist(token)
  }

  return {
    path: file,
    token: () => token,
    deviceId: () => deriveDeviceId(token),
    rotate() {
      const next = crypto.randomBytes(32).toString('hex')
      const prev = token
      token = next
      try {
        persist(next)
      } catch (e) {
        token = prev
        throw e
      }
      return { token: next, deviceId: deriveDeviceId(next) }
    },
    setToken(next) {
      if (typeof next !== 'string' || !TOKEN_RE.test(next)) {
        throw new TypeError('device: invalid token')
      }
      const prev = token
      token = next
      try {
        persist(next)
      } catch (e) {
        token = prev
        throw e
      }
    },
  }
}
