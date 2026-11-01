// BotConnection：单个 AI bot 的独立 WS 连接——薄传输层（Task 5）。
// 职责边界：连接生命周期（open/close/退避重连）、join 帧收发、入站帧原样透传。
// 刻意不做：业务帧语义解析（assign/joined/rate/join-error/history-* 一律交给 onFrame，
// 由 Task 7 runner 处置 rate 退避/join-error 重试/历史窗口）、缓存、Vue 依赖。
//
// 结构镜像 src/composables/useChat.js 的 openSocket/onclose 连接管理段（约 233-275 行），
// 剥掉了 Vue refs、nick 持久化（sessionStorage）、房间缓存与历史窗口逻辑。
// B18 隔离红线：禁止 import useChat / roomCache / roomList（Task 10 有静态依赖检查）。

export const BOT_BACKOFF = [1000, 2000, 5000] // 重连退避档位；超出停留末档 5000

// 与 server/index.js 及 useChat 一致（剔除 O/I/0/1）；复制一份而非 import——B18
const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/

/**
 * 创建一个 bot 专用 WS 连接客户端。
 * @param {{
 *   url: string,
 *   storedNick?: string | null,          // 上次服务器分配的昵称；合法才带 ?nick= 复用
 *   WebSocketImpl?: typeof WebSocket,     // 注入点：测试用替身
 *   onFrame: (frame: object) => void,     // 入站帧原样透传，不加工
 *   onStatus: (status: 'connecting' | 'open' | 'closed', detail?: string) => void,
 *   setTimeoutImpl?: (fn: () => void, ms: number) => unknown,
 *   clearTimeoutImpl?: (id: unknown) => void,
 * }} options
 * @returns {{
 *   connect: (roomId?: string) => void,
 *   send: (obj: object) => boolean,
 *   switchRoom: (roomId: string) => void,
 *   close: () => void,
 *   readonly currentRoomId: string | null,
 * }}
 */
export function createBotConnection({
  url,
  storedNick = null,
  WebSocketImpl = globalThis.WebSocket,
  onFrame,
  onStatus,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let ws = null
  let status = 'closed'
  let retries = 0 // 连续失败计数：open 归零；封顶 BOT_BACKOFF 末档
  let retryTimer = null
  let closedByUser = false // close() 置真：onclose 不再排退避重连
  let currentRoomId = null // 目标房：connect/switchRoom 记账，每次 open 自动 join（B11）

  // 仅状态变化才通知（镜像 Vue ref 同值去重语义），避免 MockSocket close() 同步
  // 触发 onclose 后 close() 收尾再报一次 closed 的重复回调
  function setStatus(next, detail) {
    if (next === status) return
    status = next
    if (onStatus) onStatus(next, detail)
  }

  function sendFrame(frame) {
    if (status !== 'open' || !ws) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  function join(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return
    sendFrame({ type: 'join', roomId })
  }

  function openSocket() {
    // 已有活连接则跳过（与 useChat.openSocket 首行守卫一致）
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
    closedByUser = false
    setStatus('connecting')
    // 连接期复用昵称：仅 storedNick 合法才带 ?nick=，非法/null 交给服务器随机分配
    const fullUrl =
      storedNick && NICK_RE.test(storedNick)
        ? `${url}${url.includes('?') ? '&' : '?'}nick=${encodeURIComponent(storedNick)}`
        : url
    ws = new WebSocketImpl(fullUrl)
    // sock 同一性守卫（审查轮 1）：真实 WS 的事件是异步派发的——close() 后旧 socket 的
    // open/close/message 可能迟到，此时 ws 已指向重连的新 socket。各 handler 捕获本次
    // socket 引用，凡 ws !== sock 一律早退：不清引用、不翻状态、不排重连、不透传帧，
    // 否则 stale close 会把活连接孤儿化并孵出第三条重复连接（useChat 存在同款竞态，范围外另行记录）
    const sock = ws
    ws.onopen = () => {
      if (ws !== sock) return
      retries = 0
      setStatus('open')
      // 首次连接进落地房；断线重连自动 rejoin 断开前所在房（B11）
      join(currentRoomId)
    }
    ws.onmessage = (ev) => {
      if (ws !== sock) return // 旧连接在途帧不混入当前会话
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return // 非 JSON 脏帧忽略（同 useChat）
      }
      if (onFrame) onFrame(frame) // 薄传输层：所有帧原样透传，语义归 runner
    }
    ws.onclose = (ev) => {
      if (ws !== sock) return
      ws = null
      const code = ev && typeof ev.code === 'number' ? ev.code : null
      setStatus('closed', code ? `close ${code}` : undefined)
      if (closedByUser) return
      const delay = BOT_BACKOFF[Math.min(retries, BOT_BACKOFF.length - 1)]
      retries += 1
      retryTimer = setTimeoutImpl(openSocket, delay)
    }
    ws.onerror = () => {
      // WebSocket 的 error 事件不带细节；真实原因在随后 close 事件的 code 里（同 useChat）
      // 空壳不触碰 ws/状态，天然无需同一性守卫
    }
  }

  function connect(roomId) {
    if (typeof roomId === 'string' && roomId !== '') currentRoomId = roomId
    openSocket()
  }

  function switchRoom(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return
    currentRoomId = roomId
    // open 立即 join；connecting/closed 只记账，下次 open 由 onopen 统一 join
    if (status === 'open') join(roomId)
  }

  function send(obj) {
    return sendFrame(obj)
  }

  function close() {
    closedByUser = true
    if (retryTimer != null) {
      clearTimeoutImpl(retryTimer)
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
    // 真实 WS 的 onclose 异步到达，这里立即收尾状态；若 onclose 已同步报过则被去重
    setStatus('closed')
  }

  return {
    connect,
    send,
    switchRoom,
    close,
    get currentRoomId() {
      return currentRoomId
    },
  }
}
