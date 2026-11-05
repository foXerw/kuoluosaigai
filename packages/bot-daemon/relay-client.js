// P3b：daemon → 聊天服务器 /device 的中继客户端。
//
// 责任边界：
// - 连接、dev-auth、断线退避（1/2/5s）、配对码、paired、命令回执、令牌轮换。
// - **不解释命令**：dev-cmd 原样交给注入的 onCommand，回执只允许 {ok, err}。
// - **不碰 deck/config**：宿主把 snapshot/命令处理器接进来。
// - 令牌只出现在 dev-auth / dev-revoke-all 帧里；日志/错误文本永不含令牌。
//
// 终态：
// - dev-auth-err（令牌失效/墓碑）→ status 'error'，停止重连；
// - dev-replaced（同设备另一个 daemon 接管）→ status 'replaced'，停止重连；
// - stop() 是宿主关停，清定时器、拒绝挂起请求。

const TOKEN_RE = /^[a-f0-9]{64}$/

export function deviceUrl(base) {
  const s = String(base || '').replace(/\/+$/, '')
  return s.endsWith('/device') ? s : s + '/device'
}

const noop = () => {}

/**
 * @param {{
 *   url: string, token: string, name: string, ver?: string,
 *   WebSocketImpl?: Function, sleep?: Function, now?: () => number,
 *   onCommand?: (frame: object) => object|Promise<object>,
 *   onStatus?: (status: string) => void, onPaired?: (frame: object) => void,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   reconnectDelays?: number[],
 * }} opts
 */
export function createRelayClient({
  url,
  token,
  name,
  ver = 'p3b',
  WebSocketImpl = globalThis.WebSocket,
  onCommand = () => ({ ok: false, err: 'unsupported' }),
  onStatus = noop,
  onPaired = noop,
  logger = {},
  reconnectDelays = [1000, 2000, 5000],
} = {}) {
  const log = (level, msg) => {
    try {
      const fn = logger[level]
      if (typeof fn === 'function') fn.call(logger, msg)
    } catch (e) {
      /* sink 免疫 */
    }
  }
  const emitStatus = (s) => {
    try {
      onStatus(s)
    } catch (e) {
      /* 宿主回调不许拖垮连接 */
    }
  }

  let currentToken = token
  let ws = null
  let started = false
  let stopped = false
  let status = 'idle'
  let paired = false
  let retries = 0
  let reconnectTimer = null
  let pendingPair = null
  let pendingRotate = null
  let info = { deviceId: null, name: null }

  function setStatus(next) {
    status = next
    emitStatus(next)
  }

  function isOpen() {
    return !!ws && ws.readyState === 1
  }

  function send(frame) {
    if (!isOpen()) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch (e) {
      return false
    }
  }

  function settlePair(err, value) {
    if (!pendingPair) return
    const p = pendingPair
    pendingPair = null
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(value)
  }

  function settleRotate(err, value) {
    if (!pendingRotate) return
    const p = pendingRotate
    pendingRotate = null
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(value)
  }

  function handleFrame(frame) {
    if (!frame || typeof frame.t !== 'string') return
    switch (frame.t) {
      case 'dev-auth-ok':
        retries = 0
        info = { deviceId: frame.deviceId || null, name: frame.name || name }
        paired = !!frame.paired
        setStatus(paired ? 'paired' : 'open')
        break
      case 'dev-auth-err':
        paired = false
        stopped = true
        setStatus('error')
        log('error', 'device auth rejected by relay')
        if (ws) {
          try { ws.close() } catch (e) { /* noop */ }
        }
        break
      case 'pair-code':
        settlePair(null, { code: frame.code, expiresMs: frame.expiresMs })
        break
      case 'paired':
        paired = true
        setStatus('paired')
        try {
          onPaired(frame)
        } catch (e) {
          /* 宿主回调异常不拖垮连接 */
        }
        break
      case 'dev-cmd':
        Promise.resolve()
          .then(() => onCommand({ id: frame.id, cmd: frame.cmd, args: frame.args, from: frame.from }))
          .then((res) => {
            const ok = !!(res && res.ok === true)
            const err = ok ? null : (res && typeof res.err === 'string' ? res.err : 'internal')
            send({ t: 'dev-res', id: frame.id, ok, err })
          })
          .catch(() => send({ t: 'dev-res', id: frame.id, ok: false, err: 'internal' }))
        break
      case 'dev-res':
        break // daemon 不该收到回执
      case 'dev-replaced':
        paired = false
        stopped = true
        setStatus('replaced')
        log('warn', 'another daemon replaced this device connection')
        settlePair(new Error('replaced'))
        settleRotate(new Error('replaced'))
        if (ws) {
          try { ws.close() } catch (e) { /* noop */ }
        }
        break
      case 'dev-revoke-ok':
        if (pendingRotate) {
          currentToken = pendingRotate.token
          paired = true
          setStatus('paired')
          settleRotate(null, { deviceId: frame.deviceId })
        }
        break
      case 'dev-revoke-err':
        settleRotate(new Error('revoke rejected'))
        break
      case 'rate':
        log('warn', 'relay rate limited')
        break
      case 'error':
        log('warn', 'relay error frame')
        break
      default:
        break
    }
  }

  function scheduleReconnect() {
    if (!started || stopped) return
    const delay = reconnectDelays[Math.min(retries, reconnectDelays.length - 1)]
    retries += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (!started || stopped) return
    setStatus('connecting')
    let sock
    try {
      sock = new WebSocketImpl(deviceUrl(url))
    } catch (e) {
      log('error', 'relay socket construction failed')
      scheduleReconnect()
      return
    }
    ws = sock
    sock.onopen = () => {
      retries = 0
      send({ t: 'dev-auth', role: 'daemon', token: currentToken, name, ver })
    }
    sock.onmessage = (ev) => {
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
      paired = false
      if (!started || stopped) return
      setStatus('closed')
      scheduleReconnect()
    }
    sock.onerror = () => {
      /* 真实原因在 close code；这里不重复 */
    }
  }

  return {
    start() {
      if (started) return
      started = true
      stopped = false
      connect()
    },
    stop() {
      started = false
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      settlePair(new Error('stopped'))
      settleRotate(new Error('stopped'))
      if (ws) {
        try { ws.close() } catch (e) { /* noop */ }
      }
      ws = null
      paired = false
      setStatus('stopped')
    },
    isOpen,
    paired() {
      return paired
    },
    status() {
      return status
    },
    currentToken() {
      return currentToken
    },
    setToken(next) {
      if (typeof next === 'string' && TOKEN_RE.test(next)) currentToken = next
    },
    getDeviceId() {
      return info.deviceId
    },
    requestPair({ timeoutMs = 5000 } = {}) {
      if (pendingPair) return Promise.reject(new Error('pair busy'))
      if (!isOpen()) return Promise.reject(new Error('not connected'))
      if (!send({ t: 'pair-new' })) return Promise.reject(new Error('not connected'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingPair && pendingPair.timer === timer) pendingPair = null
          reject(new Error('pair timeout'))
        }, timeoutMs)
        pendingPair = { resolve, reject, timer }
      })
    },
    rotate(newToken, { timeoutMs = 5000 } = {}) {
      if (pendingRotate) return Promise.reject(new Error('revoke busy'))
      if (typeof newToken !== 'string' || !TOKEN_RE.test(newToken)) {
        return Promise.reject(new Error('invalid token'))
      }
      if (!isOpen()) return Promise.reject(new Error('not connected'))
      if (!send({ t: 'dev-revoke-all', newToken })) return Promise.reject(new Error('not connected'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRotate && pendingRotate.timer === timer) pendingRotate = null
          reject(new Error('revoke timeout'))
        }, timeoutMs)
        pendingRotate = { resolve, reject, timer, token: newToken }
      })
    },
    pushState(state) {
      if (!isOpen() || !paired) return false
      return send({ t: 'dev-state', state })
    },
  }
}
