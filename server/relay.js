// P3a：设备通道状态机（spec §11.2/§11.3/§11.4/§11.6）。
//
// 连接类别：/device 路径的 WS 全部走本模块；参与者路径完全不经过这里。
// 设备连接不占房间席位、不计在线、不进历史帧流——relay 不碰 rooms/counts。
//
// 状态机：
//   unauthenticated ──dev-auth(daemon)──> daemon   （token 未知 = 未配对，只可 pair-new）
//   unauthenticated ──dev-auth(browser)─> browser  （token + 已配对 session）
//   unauthenticated ──pair-claim────────> browser  （成功即自动认证；见下）
//   daemon ──pair-new──> pending code ──pair-claim(browser)──> session + device 落盘
//
// 安全钉死：
// - 磁盘只有 devices.js 的 tokenHash；明文 token 只活在连接内存里供 pair-ok 返回。
// - 所有“认证失败”分支共用同一 dev-auth-err；所有配对失败共用同一 pair-error。
// - 任何帧（dev-state/dev-cmd args）出现 apiKey 键即拒，不转发、不落缓存（Q5(a)）。
// - 路由只认 session 自己的 deviceId；to 不符直接丢，不跨设备投递。
// - 配对尝试按 IP 5/60s；每连接帧预算 120/60s；pair-new 5/60s。
// - 单设备最多 N 个 session；超限与坏码同一错误。

import {
  isValidToken,
  hashToken,
  deriveDeviceId,
  genSessionId,
  genSessionToken,
  genPairCode,
} from './devices.js'

export const RELAY_DEFAULTS = {
  pairTtlMs: 60_000,
  pairClaimLimit: 5,
  pairWindowMs: 60_000,
  pairNewLimit: 5,
  sessionCap: 10,
  frameLimit: 120,
  stateMaxBytes: 64 * 1024,
  argsMaxBytes: 16 * 1024,
}

const SESSION_RE = /^[a-f0-9]{16}$/

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function byteLen(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v), 'utf8')
  } catch (e) {
    return Infinity
  }
}

/** 递归找 apiKey 键（不扫字符串内容，避免误伤聊天文本）。JSON 帧无环，深度帽兜底。 */
function hasApiKey(v, depth = 0) {
  // fail-closed：嵌套超过扫描深度就当作可疑拒绝，绝不因为“太深”而放行。
  if (depth > 8) return true
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some((x) => hasApiKey(x, depth + 1))
  if (Object.prototype.hasOwnProperty.call(v, 'apiKey')) return true
  for (const k of Object.keys(v)) {
    if (hasApiKey(v[k], depth + 1)) return true
  }
  return false
}

function cleanLabel(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 32) : 'device'
}

function idOk(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64
}

function cmdOk(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 32
}

/**
 * @param {{
 *   store: object, send: (ws: object, frame: object) => void,
 *   close?: (ws: object, code?: number, reason?: string) => void,
 *   now?: () => number,
 * }} opts
 */
export function createRelay({
  store,
  send,
  close = (ws, code, reason) => ws.close?.(code, reason),
  now = Date.now,
  pairTtlMs = RELAY_DEFAULTS.pairTtlMs,
  pairClaimLimit = RELAY_DEFAULTS.pairClaimLimit,
  pairWindowMs = RELAY_DEFAULTS.pairWindowMs,
  pairNewLimit = RELAY_DEFAULTS.pairNewLimit,
  sessionCap = RELAY_DEFAULTS.sessionCap,
  frameLimit = RELAY_DEFAULTS.frameLimit,
  stateMaxBytes = RELAY_DEFAULTS.stateMaxBytes,
  argsMaxBytes = RELAY_DEFAULTS.argsMaxBytes,
  genCode = genPairCode,
  genSession = genSessionId,
} = {}) {
  const infoByWs = new Map() // ws -> {role, deviceId, token?, sessionId?, name?, paired?, revoked?}
  const daemonByDevice = new Map() // deviceId -> ws
  const browsersByDevice = new Map() // deviceId -> Map<ws, {sessionId}>
  const pending = new Map() // code -> {deviceId, token, name, ws, expiresAt}
  const stateByDevice = new Map() // deviceId -> {state, ts}
  const claimBuckets = new Map() // ip -> times[]
  const frameBuckets = new Map() // ws -> times[]
  const pairNewBuckets = new Map() // ws -> times[]

  function reply(ws, frame) {
    try {
      send(ws, frame)
    } catch (e) {
      /* 单连接发送失败不拖垮中继；close 会清理 */
    }
  }

  function allowed(map, key, limit, window) {
    const t = now()
    const kept = (map.get(key) || []).filter((x) => t - x < window)
    if (kept.length >= limit) {
      map.set(key, kept)
      return false
    }
    kept.push(t)
    map.set(key, kept)
    return true
  }

  function addBrowser(ws, deviceId, sessionId) {
    let set = browsersByDevice.get(deviceId)
    if (!set) {
      set = new Map()
      browsersByDevice.set(deviceId, set)
    }
    set.set(ws, { sessionId })
  }

  function removeBrowser(ws, deviceId) {
    const set = browsersByDevice.get(deviceId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) browsersByDevice.delete(deviceId)
  }

  function broadcast(deviceId, frame, except = null) {
    const set = browsersByDevice.get(deviceId)
    if (!set) return
    for (const ws of set.keys()) {
      if (ws !== except) reply(ws, frame)
    }
  }

  function clearPendingForWs(ws) {
    for (const [code, p] of pending) {
      if (p.ws === ws) pending.delete(code)
    }
  }

  function clearPendingForDevice(deviceId) {
    for (const [code, p] of pending) {
      if (p.deviceId === deviceId) pending.delete(code)
    }
  }

  function sendSessions(ws, id) {
    const info = infoByWs.get(ws)
    const device = store.get(info.deviceId)
    const set = browsersByDevice.get(info.deviceId)
    const sessions = device
      ? Object.entries(device.sessions).map(([sessionId, s]) => ({
        sessionId,
        label: s.label,
        createdAt: s.createdAt,
        online: !!(set && [...set.values()].some((v) => v.sessionId === sessionId)),
      }))
      : []
    reply(ws, { t: 'dev-sessions-res', id, sessions })
  }

  function auth(ws, frame) {
    if (infoByWs.has(ws)) return reply(ws, { t: 'dev-auth-err' })
    const role = frame.role
    if ((role !== 'daemon' && role !== 'browser') || !isValidToken(frame.token)) {
      return reply(ws, { t: 'dev-auth-err' })
    }
    const tokenHash = hashToken(frame.token)

    if (role === 'daemon') {
      // 设备令牌与浏览器 session 令牌是两个域：session 令牌永远不能占 daemon 槽；
      // 已轮换的旧设备令牌进墓碑，不能再被用来重建设备（revoke 的持久化语义）。
      if (store.isRevoked(tokenHash) || store.hasSessionToken(tokenHash)) {
        return reply(ws, { t: 'dev-auth-err' })
      }
      const deviceId = deriveDeviceId(frame.token)
      const device = store.get(deviceId)
      const old = daemonByDevice.get(deviceId)
      if (old && old !== ws) {
        clearPendingForWs(old)
        reply(old, { t: 'dev-replaced' })
        infoByWs.delete(old)
      }
      const name = (device && device.name) || (typeof frame.name === 'string' ? frame.name.slice(0, 64) : 'device')
      const info = { role: 'daemon', deviceId, token: frame.token, name, paired: !!device }
      infoByWs.set(ws, info)
      daemonByDevice.set(deviceId, ws)
      reply(ws, { t: 'dev-auth-ok', role: 'daemon', deviceId, name, paired: !!device })
      if (device) broadcast(deviceId, { t: 'dev-online', deviceId })
      return
    }

    // 浏览器：token 是配对时服务器签发的 session 凭证，不是 daemon 设备令牌。
    const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
    const sessionId = frame.sessionId
    const device = store.get(deviceId)
    const session = device && Object.prototype.hasOwnProperty.call(device.sessions, sessionId)
      ? device.sessions[sessionId]
      : null
    const ok = device &&
      SESSION_RE.test(String(sessionId || '')) &&
      session &&
      session.tokenHash === tokenHash
    if (!ok) return reply(ws, { t: 'dev-auth-err' })

    infoByWs.set(ws, { role: 'browser', deviceId, sessionId })
    addBrowser(ws, deviceId, sessionId)
    reply(ws, {
      t: 'dev-auth-ok',
      role: 'browser',
      deviceId,
      name: device.name,
      paired: true,
      online: daemonByDevice.has(deviceId),
    })
    const cached = stateByDevice.get(deviceId)
    if (cached) reply(ws, { t: 'dev-state', deviceId, state: cached.state, ts: cached.ts })
    if (!daemonByDevice.has(deviceId)) reply(ws, { t: 'dev-offline', deviceId })
  }

  function pairNew(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'daemon') return reply(ws, { t: 'error', msg: 'unauthorized' })
    if (!allowed(pairNewBuckets, ws, pairNewLimit, pairWindowMs)) return reply(ws, { t: 'rate', ts: now() })

    clearPendingForWs(ws)
    let code = genCode()
    for (let i = 0; i < 5 && pending.has(code); i++) code = genCode()
    if (pending.has(code)) return reply(ws, { t: 'error', msg: 'code collision' })

    pending.set(code, {
      deviceId: info.deviceId,
      tokenHash: hashToken(info.token),
      name: info.name,
      ws,
      expiresAt: now() + pairTtlMs,
    })
    reply(ws, { t: 'pair-code', code, expiresMs: pairTtlMs })
  }

  function claim(ws, frame, meta) {
    if (infoByWs.has(ws)) return reply(ws, { t: 'pair-error' }) // 已认证连接不再认领
    const ip = (meta && typeof meta.ip === 'string' && meta.ip) || 'unknown'
    if (!allowed(claimBuckets, ip, pairClaimLimit, pairWindowMs)) {
      return reply(ws, { t: 'pair-error' })
    }
    const code = String(frame.code || '').trim().toUpperCase()
    const p = pending.get(code)
    if (!p) return reply(ws, { t: 'pair-error' })
    if (now() >= p.expiresAt) {
      pending.delete(code)
      return reply(ws, { t: 'pair-error' })
    }
    pending.delete(code) // 一次性：无论后续成败都不许再用

    const device = store.get(p.deviceId)
    if (device && device.tokenHash !== p.tokenHash) return reply(ws, { t: 'pair-error' })
    const sessions = device ? device.sessions : {}
    if (Object.keys(sessions).length >= sessionCap) return reply(ws, { t: 'pair-error' })

    let sessionId = genSession()
    for (let i = 0; i < 5 && Object.prototype.hasOwnProperty.call(sessions, sessionId); i++) {
      sessionId = genSession()
    }
    if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) return reply(ws, { t: 'pair-error' })

    // 浏览器拿的是独立的 session 凭证；daemon 设备令牌永不下发。
    const sessionToken = genSessionToken()
    const base = device || {
      deviceId: p.deviceId,
      tokenHash: p.tokenHash,
      name: p.name,
      createdAt: now(),
    }
    const next = {
      ...base,
      sessions: {
        ...sessions,
        [sessionId]: {
          label: cleanLabel(frame.label),
          createdAt: now(),
          tokenHash: hashToken(sessionToken),
        },
      },
    }
    try {
      store.upsert(p.deviceId, next)
    } catch (e) {
      return reply(ws, { t: 'error', msg: 'devices write failed' })
    }

    reply(ws, {
      t: 'pair-ok',
      deviceId: p.deviceId,
      name: next.name,
      token: sessionToken,
      sessionId,
    })

    // 认领者立即成为该 session 的浏览器，无需再发 dev-auth（少一次往返）。
    infoByWs.set(ws, { role: 'browser', deviceId: p.deviceId, sessionId })
    addBrowser(ws, p.deviceId, sessionId)
    const cached = stateByDevice.get(p.deviceId)
    if (cached) reply(ws, { t: 'dev-state', deviceId: p.deviceId, state: cached.state, ts: cached.ts })
    if (!daemonByDevice.has(p.deviceId)) reply(ws, { t: 'dev-offline', deviceId: p.deviceId })

    const daemon = p.ws
    const daemonInfo = daemon ? infoByWs.get(daemon) : null
    if (daemon && daemonInfo && daemonInfo.deviceId === p.deviceId) {
      daemonInfo.paired = true
      reply(daemon, { t: 'paired', deviceId: p.deviceId, sessionId })
    }
  }

  function devState(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'daemon') return reply(ws, { t: 'error', msg: 'unauthorized' })
    const device = store.get(info.deviceId)
    if (!device || device.tokenHash !== hashToken(info.token)) {
      return reply(ws, { t: 'error', msg: 'not paired' })
    }
    if (!isObject(frame.state) || hasApiKey(frame.state)) {
      return reply(ws, { t: 'error', msg: 'bad frame' })
    }
    if (byteLen(frame.state) > stateMaxBytes) return reply(ws, { t: 'error', msg: 'state too large' })
    const ts = now()
    stateByDevice.set(info.deviceId, { state: frame.state, ts })
    broadcast(info.deviceId, { t: 'dev-state', deviceId: info.deviceId, state: frame.state, ts })
  }

  function devCmd(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'browser') return reply(ws, { t: 'error', msg: 'unauthorized' })
    const id = idOk(frame.id) ? frame.id : null
    if (!id) return reply(ws, { t: 'error', msg: 'bad frame' })
    if (!cmdOk(frame.cmd)) return reply(ws, { t: 'dev-res', id, ok: false, err: 'bad cmd' })
    if (frame.to != null && frame.to !== info.deviceId) return // 不跨设备、不回报
    const args = frame.args === undefined ? null : frame.args
    if (hasApiKey(args) || byteLen(args) > argsMaxBytes) {
      return reply(ws, { t: 'dev-res', id, ok: false, err: 'bad args' })
    }
    const daemon = daemonByDevice.get(info.deviceId)
    if (!daemon) return reply(ws, { t: 'dev-res', id, ok: false, err: 'offline' })
    reply(daemon, { t: 'dev-cmd', from: info.sessionId, id, cmd: frame.cmd, args })
  }

  function devRes(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'daemon') return reply(ws, { t: 'error', msg: 'unauthorized' })
    if (!idOk(frame.id)) return reply(ws, { t: 'error', msg: 'bad frame' })
    const err = typeof frame.err === 'string' ? frame.err.slice(0, 200) : null
    broadcast(info.deviceId, { t: 'dev-res', id: frame.id, ok: frame.ok === true, err })
  }

  function sessionRevoke(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'browser') return reply(ws, { t: 'error', msg: 'unauthorized' })
    const id = idOk(frame.id) ? frame.id : null
    if (!id) return reply(ws, { t: 'error', msg: 'bad frame' })
    const sessionId = String(frame.sessionId || '')
    const device = store.get(info.deviceId)
    if (!device || !Object.prototype.hasOwnProperty.call(device.sessions, sessionId)) {
      return reply(ws, { t: 'dev-res', id, ok: false, err: 'not found' })
    }
    const sessions = { ...device.sessions }
    delete sessions[sessionId]
    try {
      store.upsert(info.deviceId, { ...device, sessions })
    } catch (e) {
      return reply(ws, { t: 'dev-res', id, ok: false, err: 'write failed' })
    }
    const set = browsersByDevice.get(info.deviceId)
    if (set) {
      for (const [bws, meta] of [...set]) {
        if (meta.sessionId !== sessionId) continue
        reply(bws, { t: 'dev-revoked' })
        close(bws, 4003, 'revoked')
        removeBrowser(bws, info.deviceId)
        infoByWs.delete(bws)
        frameBuckets.delete(bws)
      }
    }
    reply(ws, { t: 'dev-res', id, ok: true, err: null })
  }

  function revokeAll(ws, frame) {
    const info = infoByWs.get(ws)
    if (!info || info.role !== 'daemon') return reply(ws, { t: 'error', msg: 'unauthorized' })
    const newToken = frame.newToken
    if (!isValidToken(newToken) || newToken === info.token) {
      return reply(ws, { t: 'dev-revoke-err' })
    }
    const oldId = info.deviceId
    const newId = deriveDeviceId(newToken)
    const old = store.get(oldId)
    if (!old) return reply(ws, { t: 'dev-revoke-err' })
    if (newId === oldId) return reply(ws, { t: 'dev-revoke-err' })
    if (store.get(newId)) return reply(ws, { t: 'dev-revoke-err' })

    const next = {
      deviceId: newId,
      tokenHash: hashToken(newToken),
      name: old.name,
      createdAt: old.createdAt,
      sessions: {},
    }
    try {
      // 单次持久化：删旧 + 加新 + 旧令牌墓碑，失败内存回滚（不会出现双行/幽灵设备）。
      store.rotate(oldId, newId, next, hashToken(info.token))
    } catch (e) {
      return reply(ws, { t: 'dev-revoke-err' })
    }
    stateByDevice.delete(oldId)
    stateByDevice.delete(newId)

    clearPendingForDevice(oldId)
    const set = browsersByDevice.get(oldId)
    if (set) {
      for (const bws of set.keys()) {
        reply(bws, { t: 'dev-revoked' })
        close(bws, 4003, 'revoked')
        infoByWs.delete(bws)
        frameBuckets.delete(bws)
      }
      browsersByDevice.delete(oldId)
    }
    daemonByDevice.delete(oldId)
    info.deviceId = newId
    info.token = newToken
    info.paired = true
    daemonByDevice.set(newId, ws)
    reply(ws, { t: 'dev-revoke-ok', deviceId: newId })
  }

  return {
    /**
     * 处理 /device 路径上的一帧。调用方只对设备路径调用；未知帧回 bad frame。
     * @param {object} ws
     * @param {object} frame 已 JSON.parse 的帧
     * @param {{ ip?: string }} [meta]
     * @returns {true}
     */
    handle(ws, frame, meta = {}) {
      if (!isObject(frame) || typeof frame.t !== 'string') {
        reply(ws, { t: 'error', msg: 'bad frame' })
        return true
      }
      if (!allowed(frameBuckets, ws, frameLimit, pairWindowMs)) {
        reply(ws, { t: 'rate', ts: now() })
        return true
      }
      switch (frame.t) {
        case 'dev-auth': auth(ws, frame); return true
        case 'pair-claim': claim(ws, frame, meta); return true
        case 'pair-new': pairNew(ws, frame); return true
        case 'dev-state': devState(ws, frame); return true
        case 'dev-cmd': devCmd(ws, frame); return true
        case 'dev-res': devRes(ws, frame); return true
        case 'dev-sessions': {
          const info = infoByWs.get(ws)
          if (!info || info.role !== 'browser') reply(ws, { t: 'error', msg: 'unauthorized' })
          else sendSessions(ws, idOk(frame.id) ? frame.id : null)
          return true
        }
        case 'dev-session-revoke': sessionRevoke(ws, frame); return true
        case 'dev-revoke-all': revokeAll(ws, frame); return true
        default:
          reply(ws, { t: 'error', msg: 'bad frame' })
          return true
      }
    },

    onClose(ws) {
      const info = infoByWs.get(ws)
      infoByWs.delete(ws)
      frameBuckets.delete(ws)
      pairNewBuckets.delete(ws)
      if (!info) return
      clearPendingForWs(ws)
      if (info.role === 'daemon') {
        if (daemonByDevice.get(info.deviceId) === ws) daemonByDevice.delete(info.deviceId)
        stateByDevice.delete(info.deviceId) // 不把无主缓存留给下一位（也防无界增长）
        broadcast(info.deviceId, { t: 'dev-offline', deviceId: info.deviceId })
      } else if (info.role === 'browser') {
        removeBrowser(ws, info.deviceId)
      }
    },

    /** 测试/诊断用只读视图。 */
    inspect() {
      return {
        devices: daemonByDevice.size,
        pending: pending.size,
        browsers: [...browsersByDevice.values()].reduce((n, s) => n + s.size, 0),
      }
    },
  }
}
