// P3c：浏览器远端设备 store（BOT DECK 的「另一台机器」那一半）。
//
// 凭证模型（P3a/P3b）：浏览器持有配对时服务器签发的 **session token**，永远拿不到
// daemon 的设备令牌。session token 只存在本机 localStorage，不渲染、不打印。
// 通道：同一 ws 服务的 `/device` 路径；pair-claim 无需认证，dev-auth 要 deviceId+
// sessionId+token；命令走 dev-cmd/dev-res，状态走 dev-state/dev-online/dev-offline。
//
// 远端修改语义：人格/启停/增删 bot 是**运行时**修改（daemon 重启回配置）；房间切换由
// daemon 的 R20 持久化。UI 负责如实说明，本 store 不粉饰。

export const DEVICES_KEY = 'kuoluosaigai:devices:v1'
export const REMOTE_SCHEMA_VERSION = 1
const RECONNECT_MS = 3000

function deviceUrl(wsUrl) {
  const s = String(wsUrl || '').replace(/\/+$/, '')
  if (!s) return ''
  return s.endsWith('/device') ? s : s + '/device'
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validDevice(d) {
  return isObject(d) &&
    typeof d.deviceId === 'string' && d.deviceId.length > 0 &&
    typeof d.name === 'string' &&
    typeof d.token === 'string' && /^[a-f0-9]{64}$/.test(d.token) &&
    typeof d.sessionId === 'string' && /^[a-f0-9]{16}$/.test(d.sessionId)
}

function loadDevices(storage) {
  try {
    const doc = JSON.parse(storage.getItem(DEVICES_KEY))
    if (!isObject(doc) || !Array.isArray(doc.devices)) return []
    return doc.devices.filter(validDevice).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      token: d.token,
      sessionId: d.sessionId,
    }))
  } catch (e) {
    return []
  }
}

function saveDevices(storage, devices) {
  try {
    storage.setItem(DEVICES_KEY, JSON.stringify({ version: REMOTE_SCHEMA_VERSION, devices }))
  } catch (e) {
    /* 隐私模式/配额：内存态继续，不炸面板 */
  }
}

/**
 * @param {{
 *   wsUrl?: string,
 *   storage?: { getItem: Function, setItem: Function },
 *   WebSocketImpl?: Function,
 *   reactiveImpl?: (o: object) => object,
 *   commandTimeoutMs?: number,
 * }} opts
 */
export function createRemoteStore({
  wsUrl = '',
  storage = globalThis.localStorage,
  WebSocketImpl = globalThis.WebSocket,
  reactiveImpl = (o) => o,
  commandTimeoutMs = 8000,
} = {}) {
  let store = null
  let ws = null
  let seq = 0
  let reconnectTimer = null
  let pairPending = false
  let tornDown = false
  const pending = new Map() // id -> {resolve,reject,timer,type}
  const installed = loadDevices(storage)

  function persist() {
    saveDevices(storage, store.devices)
  }

  function rejectPending(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(new Error(reason))
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function send(frame) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch (e) {
      return false
    }
  }

  function selectedDevice() {
    return store.devices.find((d) => d.deviceId === store.selectedId) || null
  }

  function handleFrame(frame) {
    if (!isObject(frame) || typeof frame.t !== 'string') return
    switch (frame.t) {
      case 'dev-auth-ok':
        store.status = 'open'
        store.online = !!frame.online
        store.notice = ''
        break
      case 'dev-auth-err':
        store.status = 'error'
        store.online = false
        store.notice = '配对已失效，请重新配对这台设备'
        teardown(false)
        break
      case 'dev-state':
        store.bots = Array.isArray(frame.state && frame.state.bots) ? frame.state.bots : []
        store.providers = Array.isArray(frame.state && frame.state.providers) ? frame.state.providers : []
        break
      case 'dev-online':
        store.online = true
        break
      case 'dev-offline':
        store.online = false
        break
      case 'dev-res': {
        const p = pending.get(frame.id)
        if (!p) return
        clearTimeout(p.timer)
        pending.delete(frame.id)
        p.resolve({ ok: frame.ok === true, err: typeof frame.err === 'string' ? frame.err : null })
        break
      }
      case 'dev-sessions-res': {
        const p = pending.get(frame.id)
        store.sessions = Array.isArray(frame.sessions) ? frame.sessions : []
        if (!p) return
        clearTimeout(p.timer)
        pending.delete(frame.id)
        p.resolve(store.sessions)
        break
      }
      case 'dev-revoked':
        store.notice = '此浏览器已被撤销，需要重新配对'
        store.status = 'error'
        store.online = false
        if (store.selectedId) {
          const id = store.selectedId
          store.devices = store.devices.filter((d) => d.deviceId !== id)
          store.selectedId = store.devices[0] ? store.devices[0].deviceId : null
          persist()
        }
        teardown(false)
        break
      case 'rate':
        store.notice = '设备通道限速，稍后再试'
        break
      case 'error':
        store.notice = '设备通道返回错误'
        break
      default:
        break
    }
  }

  function teardown(notify) {
    clearReconnect()
    tornDown = true
    if (ws) {
      const old = ws
      ws = null
      try { old.close() } catch (e) { /* noop */ }
    }
    store.online = false
    rejectPending(notify)
    if (store.status !== 'error') store.status = 'closed'
  }

  function scheduleReconnect() {
    if (tornDown || !store.selectedId) return
    clearReconnect()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect(store.selectedId)
    }, RECONNECT_MS)
  }

  function connect(deviceId = store.selectedId) {
    const device = store.devices.find((d) => d.deviceId === deviceId)
    if (!device) return false
    if (!wsUrl) {
      store.status = 'offline'
      store.notice = '未配置 WS 端点，无法连接设备'
      return false
    }
    teardown('disconnected')
    store.selectedId = device.deviceId
    store.status = 'connecting'
    store.online = false
    store.notice = ''
    tornDown = false
    let sock
    try {
      sock = new WebSocketImpl(deviceUrl(wsUrl))
    } catch (e) {
      store.status = 'error'
      store.notice = 'WebSocket 构造失败'
      return false
    }
    ws = sock
    sock.onopen = () => {
      send({
        t: 'dev-auth',
        role: 'browser',
        deviceId: device.deviceId,
        token: device.token,
        sessionId: device.sessionId,
      })
    }
    sock.onmessage = (ev) => {
      if (tornDown) return
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch (e) {
        return
      }
      handleFrame(frame)
    }
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      store.online = false
      if (store.status !== 'error') store.status = 'closed'
      rejectPending('connection closed')
      if (!tornDown) scheduleReconnect()
    }
    sock.onerror = () => { /* 真实原因在 close */ }
    return true
  }

  function pair(code, label = 'browser') {
    if (pairPending) return Promise.reject(new Error('pair busy'))
    if (!wsUrl) return Promise.reject(new Error('pair unavailable'))
    const clean = String(code || '').trim().toUpperCase()
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(clean)) return Promise.reject(new Error('pair code invalid'))
    pairPending = true
    return new Promise((resolve, reject) => {
      const sock = new WebSocketImpl(deviceUrl(wsUrl))
      let settled = false
      const finish = (err, value) => {
        if (settled) return
        settled = true
        pairPending = false
        clearTimeout(timer)
        try { sock.close() } catch (e) { /* noop */ }
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('pair timeout')), commandTimeoutMs)
      sock.onopen = () => sock.send(JSON.stringify({ t: 'pair-claim', code: clean, label }))
      sock.onmessage = (ev) => {
        let frame
        try {
          frame = JSON.parse(ev.data)
        } catch (e) {
          return
        }
        if (frame.t === 'pair-error') return finish(new Error('pair failed'))
        if (frame.t !== 'pair-ok') return
        const device = {
          deviceId: String(frame.deviceId || ''),
          name: String(frame.name || 'device'),
          token: String(frame.token || ''),
          sessionId: String(frame.sessionId || ''),
        }
        if (!validDevice(device)) return finish(new Error('pair response invalid'))
        store.devices = [...store.devices.filter((d) => d.deviceId !== device.deviceId), device]
        persist()
        finish(null, device)
        connect(device.deviceId)
      }
      sock.onerror = () => finish(new Error('pair unavailable'))
    })
  }

  function command(cmd, args = {}) {
    if (store.status !== 'open' || !ws) return Promise.reject(new Error('not connected'))
    const id = 'r' + (++seq)
    if (!send({ t: 'dev-cmd', to: store.selectedId, id, cmd, args })) {
      return Promise.reject(new Error('not connected'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('command timeout'))
      }, commandTimeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
  }

  function requestSessions() {
    if (store.status !== 'open' || !ws) return Promise.reject(new Error('not connected'))
    const id = 'r' + (++seq)
    if (!send({ t: 'dev-sessions', id })) return Promise.reject(new Error('not connected'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('sessions timeout'))
      }, commandTimeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
  }

  function revokeSession(sessionId) {
    if (store.status !== 'open' || !ws) return Promise.reject(new Error('not connected'))
    const id = 'r' + (++seq)
    if (!send({ t: 'dev-session-revoke', id, sessionId })) return Promise.reject(new Error('not connected'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('revoke timeout'))
      }, commandTimeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
  }

  const raw = {
    devices: installed,
    selectedId: installed.length ? installed[0].deviceId : null,
    status: wsUrl ? 'idle' : 'offline',
    online: false,
    bots: [],
    providers: [],
    sessions: [],
    notice: '',
    pair,
    connect,
    disconnect() {
      teardown('disconnected')
      tornDown = true
      clearReconnect()
    },
    select(deviceId) {
      if (!store.devices.some((d) => d.deviceId === deviceId)) return false
      if (store.selectedId === deviceId && store.status === 'open') return true
      return connect(deviceId)
    },
    removeDevice(deviceId) {
      if (store.selectedId === deviceId) {
        teardown('disconnected')
        tornDown = true
      }
      store.devices = store.devices.filter((d) => d.deviceId !== deviceId)
      if (store.selectedId === deviceId) {
        store.selectedId = store.devices[0] ? store.devices[0].deviceId : null
      }
      store.sessions = []
      persist()
    },
    command,
    refreshSessions: requestSessions,
    revokeSession,
    startBot: (id) => command('bot.start', { id }),
    stopBot: (id) => command('bot.stop', { id }),
    updateBot: (id, patch) => command('bot.update', { id, ...patch }),
    addBot: (cfg) => command('bot.add', cfg),
    removeBot: (id) => command('bot.remove', { id }),
    switchRoom: (id, room) => command('bot.switchRoom', { id, room }),
    clearBuffer: (id) => command('buffer.clear', { id }),
    dispose() {
      teardown('disposed')
      tornDown = true
      clearReconnect()
    },
    get selectedDevice() {
      return selectedDevice()
    },
  }
  store = reactiveImpl(raw)
  return store
}
