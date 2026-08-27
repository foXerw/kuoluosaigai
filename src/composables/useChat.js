import { ref, onBeforeUnmount } from 'vue'

const BACKOFF = [1000, 2000, 5000]
const NICK_KEY = 'kuoluosaigai:nick'
const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/ // 与服务端 NICK_CHARS 一致（剔除 O/I/0/1）

function readStoredNick() {
  try {
    const v = sessionStorage.getItem(NICK_KEY)
    return NICK_RE.test(v) ? v : null
  } catch {
    return null // 隐私模式/无 sessionStorage
  }
}

function storeNick(n) {
  try {
    sessionStorage.setItem(NICK_KEY, n)
  } catch {
    // 隐私模式：忽略
  }
}

export function useChat(url, badge = '') {
  const status = ref('closed')
  const nick = ref(null)
  const messages = ref([])
  const online = ref(0)
  const error = ref(null) // 最近一次连接失败的简短原因（如 close 1006），供 UI 与控制台提示
  let ws = null
  let retries = 0
  let retryTimer = null
  let closedByUser = false

  function connect() {
    if (!url) {
      status.value = 'closed'
      return
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
    closedByUser = false
    status.value = 'connecting'
    error.value = null
    const stored = readStoredNick()
    const fullUrl = stored ? `${url}${url.includes('?') ? '&' : '?'}nick=${encodeURIComponent(stored)}` : url
    // 关键诊断：确认连的是 ws(s)://<真实主机> 还是 ws://localhost（后者说明 .env.local 被误打进生产包）
    console.info('[ws] connecting', fullUrl)
    ws = new WebSocket(fullUrl)
    ws.onopen = () => {
      retries = 0
      status.value = 'open'
    }
    ws.onmessage = (ev) => {
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (frame.type) {
        case 'assign':
          nick.value = frame.nick
          storeNick(frame.nick)
          break
        case 'presence':
          online.value = frame.online
          break
        case 'message':
        case 'join':
        case 'leave':
        case 'rate':
          messages.value.push(frame)
          break
      }
    }
    ws.onclose = (ev) => {
      status.value = 'closed'
      ws = null
      if (closedByUser) return
      const code = ev && typeof ev.code === 'number' ? ev.code : null
      error.value = code ? `close ${code}` : 'close'
      // 1006=异常断开（代理/防火墙拦截 WebSocket 升级的典型表现）；1005=无状态码
      console.warn(`[ws] closed (${code ?? 'no code'}) — 目标 ${url}；1006 通常意味着代理/防火墙拦截了升级`)
      const delay = BACKOFF[Math.min(retries, BACKOFF.length - 1)]
      retries += 1
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => {
      // WebSocket 的 error 事件不带细节；真实原因在随后 close 事件的 code 里
      error.value = error.value || 'error'
    }
  }

  function send(text) {
    if (status.value !== 'open' || !ws) return
    ws.send(JSON.stringify({ type: 'message', text, badge }))
  }

  function disconnect() {
    closedByUser = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        // already closed
      }
      ws = null
    }
    status.value = 'closed'
  }

  onBeforeUnmount(disconnect)

  return { status, error, nick, messages, online, send, connect, disconnect }
}
