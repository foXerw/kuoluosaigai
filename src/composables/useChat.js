import { ref, onBeforeUnmount } from 'vue'

const BACKOFF = [1000, 2000, 5000]

export function useChat(url, badge = '') {
  const status = ref('closed')
  const nick = ref(null)
  const messages = ref([])
  const online = ref(0)
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
    ws = new WebSocket(url)
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
    ws.onclose = () => {
      status.value = 'closed'
      ws = null
      if (closedByUser) return
      const delay = BACKOFF[Math.min(retries, BACKOFF.length - 1)]
      retries += 1
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => {}
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

  return { status, nick, messages, online, send, connect, disconnect }
}
