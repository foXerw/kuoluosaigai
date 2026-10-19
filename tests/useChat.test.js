import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useChat } from '../src/composables/useChat'
import { __resetFallbackForTest } from '../src/chat/roomList'

class MockSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    MockSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      if (this.onopen) this.onopen()
    }, 0)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    if (this.onclose) this.onclose()
  }
  emit(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }
}
MockSocket.instances = []

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

function framesOf(s) {
  return s.sent.map((d) => JSON.parse(d))
}

function lastSocket() {
  return MockSocket.instances[MockSocket.instances.length - 1]
}

// 输入帧夹具：与服务端 message 帧形状一致（type/id/ts/roomId/nick/badge/text）
function msg(id, ts, roomId, text) {
  return { type: 'message', id, ts, roomId, nick: 'ANON-PEER', badge: '', text }
}

const PUBLIC = ['setsubun', 'nebula', 'magenta', 'amber']

const mountedWrappers = []

function mountChat(url = 'ws://test', options = { badge: 'SETSUBUN' }) {
  const Comp = defineComponent({
    setup() {
      const c = useChat(url, options)
      return { c }
    },
    render() {
      return h('div')
    },
  })
  const w = mount(Comp)
  mountedWrappers.push(w)
  return w
}

// 连接 → open →（可选）joined 的公共前置；返回当前 socket
async function openChat(c, { room = null, joined = null } = {}) {
  c.connect(room ?? undefined)
  await flush()
  const s = lastSocket()
  if (joined) s.emit({ type: 'joined', roomId: joined, online: 1, selfId: 1 })
  return s
}

describe('useChat', () => {
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
    sessionStorage.clear()
    localStorage.clear()
    __resetFallbackForTest()
  })
  afterEach(() => {
    // 统一卸载：disconnect 会清掉重连/历史窗口/notice 定时器，避免跨用例串扰
    while (mountedWrappers.length) {
      try {
        mountedWrappers.pop().unmount()
      } catch {
        // 用例内已手动 unmount
      }
    }
    vi.useRealTimers()
    delete global.WebSocket
  })

  describe('v1 behavior preserved', () => {
    it('connects, goes open, and stores the assigned nick', async () => {
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await flush()
      expect(w.vm.c.status.value).toBe('open')
      lastSocket().emit({ type: 'assign', nick: 'ANON-7K2Q' })
      expect(w.vm.c.nick.value).toBe('ANON-7K2Q')
      expect(sessionStorage.getItem('kuoluosaigai:nick')).toBe('ANON-7K2Q')
    })

    it('send posts a message frame with badge only when open', async () => {
      const w = mountChat()
      const c = w.vm.c
      c.send('no') // closed -> no socket at all
      expect(MockSocket.instances).toHaveLength(0)
      const s = await openChat(c, { room: 'setsubun' })
      c.send('hello')
      const sent = framesOf(s)
      expect(sent[sent.length - 1]).toEqual({ type: 'message', text: 'hello', badge: 'SETSUBUN' })
    })

    it('reconnects with 1000ms backoff after an unexpected close', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0) // flush open
      expect(MockSocket.instances).toHaveLength(1)
      MockSocket.instances[0].close() // schedules reconnect(1000ms)
      expect(w.vm.c.status.value).toBe('closed')
      await vi.advanceTimersByTimeAsync(999)
      expect(MockSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockSocket.instances).toHaveLength(2)
    })

    it('surfaces the close code so proxy/firewall failures are diagnosable', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      MockSocket.instances[0].onclose({ code: 1006 })
      expect(w.vm.c.error.value).toBe('close 1006')
    })

    it('disconnect on unmount closes the socket and prevents further reconnects', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = MockSocket.instances[0]
      const closeSpy = vi.spyOn(s, 'close')
      w.unmount()
      expect(closeSpy).toHaveBeenCalled()
      const count = MockSocket.instances.length
      await vi.advanceTimersByTimeAsync(10000)
      expect(MockSocket.instances.length).toBe(count)
    })

    it('sends the stored nick as a query param on connect', async () => {
      sessionStorage.setItem('kuoluosaigai:nick', 'ANON-ABCD')
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await flush()
      expect(MockSocket.instances[0].url).toContain('nick=ANON-ABCD')
    })

    it('ignores a malformed stored nick and connects clean', async () => {
      sessionStorage.setItem('kuoluosaigai:nick', '<script>')
      const w = mountChat()
      w.vm.c.connect('setsubun')
      await flush()
      expect(MockSocket.instances[0].url).not.toContain('nick=')
    })

    it('empty url keeps status closed and creates no socket (offline degradation)', () => {
      const w = mountChat('')
      w.vm.c.connect('setsubun')
      expect(MockSocket.instances).toHaveLength(0)
      expect(w.vm.c.status.value).toBe('closed')
    })
  })

  describe('join / joined / room-scoped state', () => {
    it('rooms initializes to the four public room ids', () => {
      const w = mountChat()
      expect(w.vm.c.rooms.value).toEqual(PUBLIC)
    })

    it('connect(landingRoomId) sends a join frame once the socket opens', async () => {
      const w = mountChat()
      const s = await openChat(w.vm.c, { room: 'setsubun' })
      expect(framesOf(s)).toEqual([{ type: 'join', roomId: 'setsubun' }])
    })

    it('connect() without a landing room opens without joining', async () => {
      const w = mountChat()
      const s = await openChat(w.vm.c)
      expect(framesOf(s)).toEqual([])
      expect(w.vm.c.status.value).toBe('open')
    })

    it('joined sets currentRoom/selfId/online and adds a private room to rooms', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'abc123' })
      s.emit({ type: 'joined', roomId: 'abc123', online: 4, selfId: 42 })
      expect(c.currentRoom.value).toBe('abc123')
      expect(c.selfId.value).toBe(42)
      expect(c.online.value).toBe(4)
      expect(c.rooms.value).toEqual([...PUBLIC, 'abc123'])
      // online>1：joined 即触发历史请求
      expect(framesOf(s)).toEqual([
        { type: 'join', roomId: 'abc123' },
        { type: 'history-req' },
      ])
    })

    it('caches message frames for the current room only', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      // online===1：不请求历史（只有 join 帧）
      expect(framesOf(s)).toEqual([{ type: 'join', roomId: 'setsubun' }])
      s.emit(msg('a1', 100, 'setsubun', 'in-room'))
      s.emit(msg('a2', 200, 'nebula', 'wrong-room'))
      expect(c.messages.value.map((m) => m.text)).toEqual(['in-room'])
      expect(c.cache.get('nebula')).toEqual([])
    })

    it('applies presence to the current room only', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      s.emit({ type: 'presence', roomId: 'setsubun', online: 5 })
      expect(c.online.value).toBe(5)
      s.emit({ type: 'presence', roomId: 'nebula', online: 9 })
      expect(c.online.value).toBe(5)
    })

    it('keeps join/leave as per-room transient system lines that survive room switches', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      s.emit(msg('m1', 100, 'setsubun', 'hello'))
      s.emit({ type: 'join', roomId: 'setsubun', nick: 'ANON-AAAA', ts: 200 })
      s.emit({ type: 'leave', roomId: 'setsubun', nick: 'ANON-AAAA', ts: 300 })
      s.emit({ type: 'join', roomId: 'nebula', nick: 'ANON-BBBB', ts: 250 }) // 非当前房：丢弃
      expect(c.messages.value.map((m) => m.type)).toEqual(['message', 'join', 'leave'])
      // 切到 nebula：视图跟随 currentRoom（该房本会话无内容）
      s.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 1 })
      expect(c.messages.value).toEqual([])
      // 切回 setsubun：缓存消息与本会话系统行都还在
      s.emit({ type: 'joined', roomId: 'setsubun', online: 1, selfId: 1 })
      expect(c.messages.value.map((m) => m.type)).toEqual(['message', 'join', 'leave'])
    })

    it('caps the message view at 500 (600 frames in, oldest 100 dropped)', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      for (let i = 1; i <= 600; i++) s.emit(msg('m' + i, i, 'setsubun', 't' + i))
      expect(c.messages.value).toHaveLength(500)
      expect(c.messages.value[0].id).toBe('m101')
      expect(c.messages.value[499].id).toBe('m600')
    })
  })

  describe('P2P history window', () => {
    it('online>1 sends history-req and merges responses when the 2000ms window closes', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      s.emit({ type: 'joined', roomId: 'setsubun', online: 2, selfId: 1 })
      expect(framesOf(s)).toEqual([
        { type: 'join', roomId: 'setsubun' },
        { type: 'history-req' },
      ])
      s.emit(msg('live', 500, 'setsubun', 'live-now'))
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 2,
        messages: [
          { type: 'message', id: 'h1', ts: 100, roomId: 'setsubun', nick: 'ANON-AAAA', badge: '', text: 'old1' },
          { type: 'message', id: 'h2', ts: 200, roomId: 'setsubun', nick: 'ANON-BBBB', badge: '', text: 'old2' },
        ],
      })
      await vi.advanceTimersByTimeAsync(1999)
      expect(c.messages.value.map((m) => m.text)).toEqual(['live-now']) // 窗口未到点：不合并
      await vi.advanceTimersByTimeAsync(1)
      expect(c.messages.value.map((m) => m.text)).toEqual(['old1', 'old2', 'live-now']) // ts 升序
    })

    it('adopts only ids backed by >=2 responders when two respond', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      s.emit({ type: 'joined', roomId: 'setsubun', online: 3, selfId: 1 })
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 2,
        messages: [
          { type: 'message', id: 'a', ts: 10, roomId: 'setsubun', nick: 'ANON-AAAA', badge: '', text: 'only-a' },
          { type: 'message', id: 'b', ts: 20, roomId: 'setsubun', nick: 'ANON-BBBB', badge: '', text: 'both' },
        ],
      })
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 3,
        messages: [
          { type: 'message', id: 'b', ts: 20, roomId: 'setsubun', nick: 'ANON-BBBB', badge: '', text: 'both' },
          { type: 'message', id: 'c', ts: 30, roomId: 'setsubun', nick: 'ANON-CCCC', badge: '', text: 'only-c' },
        ],
      })
      await vi.advanceTimersByTimeAsync(2000)
      expect(c.messages.value.map((m) => m.text)).toEqual(['both'])
    })

    it('ignores history-res for a mismatched room and after the window closed (Review Focus #1)', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      s.emit({ type: 'joined', roomId: 'setsubun', online: 2, selfId: 1 })
      s.emit({
        type: 'history-res',
        roomId: 'nebula', // 别的房：逐帧校验必须丢弃
        from: 2,
        messages: [{ type: 'message', id: 'evil', ts: 10, roomId: 'nebula', nick: 'ANON-EVIL', badge: '', text: 'cross-room' }],
      })
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 3,
        messages: [{ type: 'message', id: 'ok', ts: 20, roomId: 'setsubun', nick: 'ANON-OKAY', badge: '', text: 'same-room' }],
      })
      await vi.advanceTimersByTimeAsync(2000)
      expect(c.messages.value.map((m) => m.text)).toEqual(['same-room'])
      // 窗口已关：迟到的同房 history-res 也不再入缓存
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 4,
        messages: [{ type: 'message', id: 'late', ts: 30, roomId: 'setsubun', nick: 'ANON-LATE', badge: '', text: 'too-late' }],
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(c.messages.value.map((m) => m.text)).toEqual(['same-room'])
    })

    it('switching rooms cancels the pending window without merging', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      s.emit({ type: 'joined', roomId: 'setsubun', online: 2, selfId: 1 })
      s.emit({
        type: 'history-res',
        roomId: 'setsubun',
        from: 2,
        messages: [{ type: 'message', id: 'd1', ts: 10, roomId: 'setsubun', nick: 'ANON-AAAA', badge: '', text: 'discarded' }],
      })
      s.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 1 }) // 秒切房：旧窗口取消
      await vi.advanceTimersByTimeAsync(2000)
      s.emit({ type: 'joined', roomId: 'setsubun', online: 1, selfId: 1 }) // 单人回房：不开新窗口
      expect(c.messages.value).toEqual([])
    })

    it('answers a peer history-req with the cached frames, to=from', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      s.emit(msg('m1', 10, 'setsubun', 'one'))
      s.emit(msg('m2', 20, 'setsubun', 'two'))
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 9 })
      const sent = framesOf(s)
      expect(sent[sent.length - 1]).toEqual({
        type: 'history-res',
        roomId: 'setsubun',
        to: 9,
        messages: [
          { type: 'message', id: 'm1', ts: 10, roomId: 'setsubun', nick: 'ANON-PEER', badge: '', text: 'one' },
          { type: 'message', id: 'm2', ts: 20, roomId: 'setsubun', nick: 'ANON-PEER', badge: '', text: 'two' },
        ],
      })
    })

    it('truncates a history response to the last 200 messages', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      for (let i = 1; i <= 205; i++) s.emit(msg('m' + i, i, 'setsubun', 't' + i))
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 9 })
      const res = framesOf(s).filter((f) => f.type === 'history-res')
      expect(res).toHaveLength(1)
      expect(res[0].messages).toHaveLength(200)
      expect(res[0].messages[0].id).toBe('m6')
      expect(res[0].messages[199].id).toBe('m205')
    })

    it('never answers its own selfId, another room, or from an empty cache', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun' })
      s.emit({ type: 'joined', roomId: 'setsubun', online: 1, selfId: 7 })
      // 空缓存：不回（spec §5.2.3）
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 9 })
      expect(framesOf(s).filter((f) => f.type === 'history-res')).toHaveLength(0)
      s.emit(msg('m1', 10, 'setsubun', 'one'))
      // from === selfId：缓存非空也永不回（协议红线）
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 7 })
      expect(framesOf(s).filter((f) => f.type === 'history-res')).toHaveLength(0)
      // 有缓存 + 他人请求：正常回
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 9 })
      const res = framesOf(s).filter((f) => f.type === 'history-res')
      expect(res).toHaveLength(1)
      expect(res[0].to).toBe(9)
      // 切房后，对旧房（缓存仍在）的陈旧请求也拒绝——服务器已保证同房，此为客户端双保险
      s.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 7 })
      s.emit({ type: 'history-req', roomId: 'setsubun', from: 9 })
      expect(framesOf(s).filter((f) => f.type === 'history-res')).toHaveLength(1)
    })
  })

  describe('create / notices / counts / removeRoom', () => {
    it('create sends a create frame; created banks the id; joined selects the room', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun' })
      c.create()
      expect(framesOf(s)).toContainEqual({ type: 'create' })
      s.emit({ type: 'created', roomId: 'k7x2ab' })
      expect(c.rooms.value).toEqual([...PUBLIC, 'k7x2ab']) // 建房回执即入列（防 created↔joined 间断线丢 ID）
      expect(c.currentRoom.value).toBe(null) // 选中/在线数等待 joined 统一处理
      s.emit({ type: 'joined', roomId: 'k7x2ab', online: 1, selfId: 2 })
      expect(c.currentRoom.value).toBe('k7x2ab')
      expect(c.selfId.value).toBe(2)
      expect(c.online.value).toBe(1)
    })

    it('join-error unknown shows NO SUCH ROOM and auto-clears after 5s', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      c.join('zzzzzz')
      s.emit({ type: 'join-error', roomId: 'zzzzzz', reason: 'unknown' })
      expect(c.joinNotice.value).toBe('NO SUCH ROOM')
      await vi.advanceTimersByTimeAsync(4999)
      expect(c.joinNotice.value).toBe('NO SUCH ROOM')
      await vi.advanceTimersByTimeAsync(1)
      expect(c.joinNotice.value).toBe('')
    })

    it('join-error full shows ROOM FULL', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun' })
      c.join('packed')
      s.emit({ type: 'join-error', roomId: 'packed', reason: 'full' })
      expect(c.joinNotice.value).toBe('ROOM FULL')
    })

    it('rate while a join/create is pending shows SLOW DOWN; plain message rate stays a system line', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s = lastSocket()
      // (a) 无挂起动作：消息限速 rate → v1 行为，落当前房系统行，不动 notice
      s.emit({ type: 'joined', roomId: 'setsubun', online: 1, selfId: 1 })
      s.emit({ type: 'rate', ts: 111 })
      expect(c.joinNotice.value).toBe('')
      expect(c.messages.value.map((m) => m.type)).toEqual(['rate'])
      // (b) 挂起 join：rate → SLOW DOWN，且不进消息视图
      c.join('abc123')
      s.emit({ type: 'rate', ts: 222 })
      expect(c.joinNotice.value).toBe('SLOW DOWN')
      expect(c.messages.value.map((m) => m.type)).toEqual(['rate'])
      await vi.advanceTimersByTimeAsync(5000)
      expect(c.joinNotice.value).toBe('')
      // (c) 挂起 create：rate → SLOW DOWN
      s.emit({ type: 'joined', roomId: 'abc123', online: 1, selfId: 2 })
      c.create()
      s.emit({ type: 'rate', ts: 333 })
      expect(c.joinNotice.value).toBe('SLOW DOWN')
    })

    it('merges counts frames into the counts ref', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun' })
      s.emit({ type: 'counts', counts: { nebula: 3, abc123: 1 } })
      expect(c.counts.value).toEqual({ nebula: 3, abc123: 1 })
      s.emit({ type: 'counts', counts: { nebula: 0 } })
      expect(c.counts.value).toEqual({ nebula: 0, abc123: 1 }) // 合入：新值覆盖、旧键保留
    })

    it('refreshCounts sends a counts frame (default: all rooms; custom ids respected)', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun' })
      c.refreshCounts()
      expect(framesOf(s)).toContainEqual({ type: 'counts', roomIds: PUBLIC })
      c.refreshCounts(['abc123', 'k7x2ab'])
      expect(framesOf(s)).toContainEqual({ type: 'counts', roomIds: ['abc123', 'k7x2ab'] })
    })

    it('removeRoom drops a private room from list and cache, and refuses public rooms', async () => {
      const w = mountChat()
      const c = w.vm.c
      const s = await openChat(c, { room: 'setsubun', joined: 'setsubun' })
      s.emit(msg('p1', 5, 'setsubun', 'public-kept'))
      c.join('abc123')
      s.emit({ type: 'joined', roomId: 'abc123', online: 1, selfId: 2 })
      s.emit(msg('m1', 10, 'abc123', 'doomed'))
      expect(c.messages.value).toHaveLength(1)
      c.removeRoom('abc123')
      expect(c.rooms.value).toEqual(PUBLIC)
      expect(c.cache.get('abc123')).toEqual([])
      expect(c.messages.value).toEqual([])
      c.removeRoom('setsubun') // 公共房：原样拒绝，列表与缓存都不动
      expect(c.rooms.value).toEqual(PUBLIC)
      expect(c.cache.get('setsubun').map((m) => m.id)).toEqual(['p1'])
    })
  })

  describe('reconnect rejoin (Review Focus #5)', () => {
    it('rejoins the room it was in before the drop, keeping the nick param', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('setsubun')
      await vi.advanceTimersByTimeAsync(0)
      const s0 = MockSocket.instances[0]
      s0.emit({ type: 'assign', nick: 'ANON-KEEP' })
      c.join('nebula') // 落地 setsubun，但断开前人在 nebula
      s0.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 3 })
      s0.close()
      await vi.advanceTimersByTimeAsync(1000)
      // 重连 socket 的 0ms open 定时器是在 tick(1000) 内嵌套调度的，
      // sinon 语义下需再推进 ≥1ms 才会触发（tick(0) 不跑本轮嵌套定时器）
      await vi.advanceTimersByTimeAsync(1)
      const s1 = MockSocket.instances[1]
      expect(s1.url).toContain('nick=ANON-KEEP')
      expect(framesOf(s1)).toEqual([{ type: 'join', roomId: 'nebula' }]) // 优先断开前的 currentRoom
      expect(c.status.value).toBe('open')
    })

    it('falls back to the landing room when no room was ever joined', async () => {
      vi.useFakeTimers()
      const w = mountChat()
      const c = w.vm.c
      c.connect('nebula')
      await vi.advanceTimersByTimeAsync(0)
      MockSocket.instances[0].close() // 从未收到 joined
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1) // flush 嵌套调度的 open 定时器（同上）
      expect(framesOf(MockSocket.instances[1])).toEqual([{ type: 'join', roomId: 'nebula' }])
    })
  })
})
