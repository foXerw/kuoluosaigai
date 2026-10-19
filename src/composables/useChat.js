import { ref, computed, onBeforeUnmount } from 'vue'
import { mergeHistory } from '../chat/historyMerge'
import { createRoomCache } from '../chat/roomCache'
import { loadRooms, addRoom, removeRoom as removeStoredRoom } from '../chat/roomList'

const BACKOFF = [1000, 2000, 5000]
const NICK_KEY = 'kuoluosaigai:nick'
const NICK_RE = /^ANON-[A-HJ-NP-Z2-9]{4}$/ // 与服务端 NICK_CHARS 一致（剔除 O/I/0/1）
const HISTORY_WINDOW_MS = 2000 // spec §7：history-res 收集窗口
const HISTORY_RES_MAX = 200 // spec §7：历史响应每份上限（服务器同样硬截断，这里先自律）
const NOTICE_MS = 5000 // joinNotice 自动清除

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

export function useChat(url, { badge = '' } = {}) {
  const status = ref('closed')
  const nick = ref(null)
  const error = ref(null) // 最近一次连接失败的简短原因（如 close 1006），供 UI 与控制台提示
  const currentRoom = ref(null)
  const selfId = ref(null)
  const online = ref(0) // 当前房在线数
  const rooms = ref(loadRooms())
  const counts = ref({})
  const joinNotice = ref('') // '' | 'NO SUCH ROOM' | 'ROOM FULL' | 'SLOW DOWN'
  // cache 与 sysByRoom 都是非响应式容器（Map/内部数组）：每次写入 +1，
  // 作为 messages computed 的重算信号（Map 变异本身不触发 Vue 依赖）
  const cacheRev = ref(0)

  const cache = createRoomCache() // 默认 20 房 × 500 条（spec §7），只存用户消息帧
  // 本会话瞬时系统帧（join/leave/消息限速 rate）按房分桶，不进缓存：
  // spec §5.2 历史 = 消息，系统行不属于 P2P 历史，随会话生灭
  const sysByRoom = new Map()

  let ws = null
  let retries = 0
  let retryTimer = null
  let closedByUser = false
  let landingRoom = null // connect(landingRoomId) 记录；重连时仅在从未入过房时兜底
  let pendingRoomAction = null // 'join' | 'create'：区分 rate 帧语境（房动作节流 vs 消息限速）
  let histWindow = null // { roomId, responses, timer }
  let noticeTimer = null

  // 当前房视图 = 消息缓存 ∪ 本会话该系统帧，ts 升序。
  // 永远返回新数组：cache.get 返回的是内部活数组，不得作为长命视图外泄；
  // 且 computed 值若引用不变（Object.is 相同）订阅者不会收到通知。
  const messages = computed(() => {
    cacheRev.value // 依赖收集：非响应式写入靠版本信号
    const room = currentRoom.value
    if (!room) return []
    const cached = cache.get(room)
    const sys = sysByRoom.get(room) || []
    return [...cached, ...sys].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  })

  function sendFrame(frame) {
    if (status.value !== 'open' || !ws) return false
    ws.send(JSON.stringify(frame))
    return true
  }

  function setNotice(text) {
    joinNotice.value = text
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      joinNotice.value = ''
      noticeTimer = null
    }, NOTICE_MS)
  }

  function pushSys(roomId, frame) {
    let arr = sysByRoom.get(roomId)
    if (!arr) {
      arr = []
      sysByRoom.set(roomId, arr)
    }
    arr.push(frame) // 帧只读引用存储，绝不原地修改（与 historyMerge/roomCache 共享引用）
    cacheRev.value += 1
  }

  function closeHistoryWindow() {
    if (!histWindow) return
    clearTimeout(histWindow.timer)
    histWindow = null
  }

  function openHistoryWindow(roomId) {
    closeHistoryWindow()
    const responses = []
    const timer = setTimeout(() => {
      histWindow = null
      // 到点按开窗时的房间合并；responses 里的帧只读（mergeHistory 只取 .messages）。
      // 每房上限不在这里重复定义：mergeHistory 与 roomCache.replace 的默认 500 即唯一护栏常量（计划 Global Constraints）
      const merged = mergeHistory(cache.get(roomId), responses)
      cache.replace(roomId, merged)
      cacheRev.value += 1
    }, HISTORY_WINDOW_MS)
    histWindow = { roomId, responses, timer }
  }

  function handleJoined(frame) {
    pendingRoomAction = null
    // 入房成功即清提示：NO SUCH ROOM/ROOM FULL/SLOW DOWN 的假报错不得存活到 joined 之后；
    // 5s 定时器一并取消（定时器同一性）——防止陈旧到期回调把之后的新提示提前清掉
    if (noticeTimer) {
      clearTimeout(noticeTimer)
      noticeTimer = null
    }
    joinNotice.value = ''
    currentRoom.value = frame.roomId
    selfId.value = frame.selfId
    online.value = frame.online
    cache.touch(frame.roomId)
    rooms.value = addRoom(frame.roomId) // 持久化尽力而为：以返回列表为准（配额失败也不丢会话内列表）
    // 切房/重进一律取消旧窗口（已收集的响应作废——重进该房会重新请求）
    closeHistoryWindow()
    if (frame.online > 1) {
      // spec §5.2.1：房内还有别人才值得要历史；重连回房同样走此流程（§5.2.4）
      sendFrame({ type: 'history-req' })
      openHistoryWindow(frame.roomId)
    }
  }

  function handleHistoryReq(frame) {
    const to = frame.from
    // 协议红线：绝不回 to === 自己 selfId 的 history-res（服务器会原路回显成环）
    if (to == null || to === selfId.value) return
    // 服务器已保证请求者与我同房；客户端再校验一次（Review Focus #1 同理的双保险）
    if (frame.roomId !== currentRoom.value) return
    const msgs = cache.get(frame.roomId)
    if (!msgs.length) return // 没有就不回（spec §5.2.3）
    sendFrame({
      type: 'history-res',
      roomId: frame.roomId,
      to,
      messages: msgs.slice(-HISTORY_RES_MAX),
    })
  }

  function handleHistoryRes(frame) {
    if (!histWindow) return
    // Review Focus #1 客户端半：逐帧校验 roomId === 当前房，防秒切房间的跨房污染；
    // 迟到（窗口已关）的响应同样被 !histWindow 挡下
    if (frame.roomId !== currentRoom.value) return
    if (frame.roomId !== histWindow.roomId) return
    histWindow.responses.push(frame)
  }

  function handleRate(frame) {
    if (pendingRoomAction) {
      // join/create 挂起期间的 rate = 房动作节流（join 失败饱和 / create 超速）→ 抽屉提示
      pendingRoomAction = null
      setNotice('SLOW DOWN')
      return
    }
    // 消息限速 rate：沿用 v1 行为，落当前房视图的系统行（ChatRoom sysText 渲染）
    if (currentRoom.value) pushSys(currentRoom.value, frame)
  }

  function handleFrame(frame) {
    switch (frame.type) {
      case 'assign':
        nick.value = frame.nick
        storeNick(frame.nick)
        break
      case 'joined':
        handleJoined(frame)
        break
      case 'join-error':
        pendingRoomAction = null
        if (frame.reason === 'unknown') setNotice('NO SUCH ROOM')
        else if (frame.reason === 'full') setNotice('ROOM FULL')
        break
      case 'created':
        // 建房回执：ID 立即落「我的房间」（防 created↔joined 之间断线把 ID 弄丢）；
        // 选房/在线数/selfId 等一律由随后的 joined 统一处理
        pendingRoomAction = null
        if (typeof frame.roomId === 'string' && frame.roomId !== '') {
          rooms.value = addRoom(frame.roomId)
        }
        break
      case 'presence':
        if (frame.roomId === currentRoom.value) online.value = frame.online
        break
      case 'join':
      case 'leave':
        if (frame.roomId === currentRoom.value) pushSys(frame.roomId, frame)
        break
      case 'message':
        // 仅当前房入缓存（服务器只发同房消息，这里是防御性双保险）
        if (frame.roomId === currentRoom.value) {
          cache.append(frame.roomId, frame) // 帧只读引用入缓存
          cacheRev.value += 1
        }
        break
      case 'history-req':
        handleHistoryReq(frame)
        break
      case 'history-res':
        handleHistoryRes(frame)
        break
      case 'counts':
        if (frame.counts && typeof frame.counts === 'object') {
          counts.value = { ...counts.value, ...frame.counts }
        }
        break
      case 'rate':
        handleRate(frame)
        break
      // 'error' 与未知帧：静默忽略（同 v1）
    }
  }

  function openSocket() {
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
      // 重连优先回断开前所在房；从未入过房则回落地房（Review Focus #5）
      const target = currentRoom.value || landingRoom
      if (target) join(target)
    }
    ws.onmessage = (ev) => {
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return
      }
      handleFrame(frame)
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
      retryTimer = setTimeout(openSocket, delay)
    }
    ws.onerror = () => {
      // WebSocket 的 error 事件不带细节；真实原因在随后 close 事件的 code 里
      error.value = error.value || 'error'
    }
  }

  function connect(landingRoomId) {
    if (!url) {
      status.value = 'closed'
      return // v1 离线降级：不建 socket，ChatRoom 显示离线画面
    }
    if (landingRoomId) landingRoom = landingRoomId
    openSocket()
  }

  function join(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return
    if (!sendFrame({ type: 'join', roomId })) return
    pendingRoomAction = 'join' // 挂起标记：此后第一帧 rate 判为房动作节流
  }

  function create() {
    if (!sendFrame({ type: 'create' })) return
    pendingRoomAction = 'create'
  }

  function send(text) {
    sendFrame({ type: 'message', text, badge })
  }

  function refreshCounts(ids = rooms.value) {
    if (!Array.isArray(ids)) return
    sendFrame({ type: 'counts', roomIds: ids })
  }

  function removeRoom(roomId) {
    const next = removeStoredRoom(roomId) // 公共房 id 原样拒绝（返回列表仍含该 id）
    if (!next.includes(roomId)) {
      cache.drop(roomId) // 真的移除了才丢缓存
      cacheRev.value += 1
    }
    rooms.value = next
  }

  function disconnect() {
    closedByUser = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    closeHistoryWindow()
    if (noticeTimer) {
      clearTimeout(noticeTimer)
      noticeTimer = null
    }
    joinNotice.value = ''
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

  return {
    status,
    error,
    nick,
    currentRoom,
    selfId,
    messages, // computed：当前房缓存 ∪ 本会话系统帧，ts 升序
    online,
    rooms,
    counts,
    joinNotice,
    connect, // connect(landingRoomId)：open 后 join 它；重连优先断开前 currentRoom
    disconnect,
    join,
    create,
    send,
    refreshCounts,
    removeRoom,
    cache, // roomCache 实例：供 Task 10 集成校验（如 removeRoom 后 cache.get 为空）；API 自带防误用护栏
  }
}
