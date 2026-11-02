import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBotConnection, BOT_BACKOFF } from 'kuoluosaigai-bot-core'

// MockSocket 照抄 tests/useChat.test.js 顶部模式：instances 数组 + emit 助手。
// 构造里 setTimeout(0) 延迟 open——配合 vi.useFakeTimers 时用
// await vi.advanceTimersByTimeAsync(n) 推进（n≥0 即触发 onopen，退避同理）。
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

// StubSocket：不自动 open 的 ws 替身，供「连续失败未到 open」的退避档位链使用——
// MockSocket 的 0ms open 会在任何时间推进中触发、把计数器归零，无法演 1000→2000→5000 连败。
// fail(code) 模拟代理/防火墙式异常断开（带 close code、非用户 close()）。
// close() 刻意模拟真实 WebSocket 语义：只记 closedRequested，**不**同步派发 onclose——
// 关闭事件由测试稍后手动 fail()/触发，用以复现「迟到 close 事件」的 stale-socket 竞态。
class StubSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closedRequested = false
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    StubSocket.instances.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  open() {
    this.readyState = 1
    if (this.onopen) this.onopen()
  }
  fail(code) {
    this.readyState = 3
    if (this.onclose) this.onclose({ code })
  }
  close() {
    this.closedRequested = true
  }
  // 模拟在途/迟到的入站帧（真实 WS 上 close 前已到达的 message 事件）
  emit(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }
}
StubSocket.instances = []

function lastSocket() {
  return MockSocket.instances[MockSocket.instances.length - 1]
}

function framesOf(s) {
  return s.sent.map((d) => JSON.parse(d))
}

// 可选手动调度的计时器：注入 setTimeoutImpl/clearTimeoutImpl，让退避档位链完全同步、零推进
function makeScheduler() {
  const scheduled = [] // 记录每次 setTimeoutImpl 的 ms，供断言档位序列
  const jobs = new Map()
  let now = 0
  let seq = 0
  return {
    scheduled,
    pending: () => jobs.size,
    setTimeoutImpl: (fn, ms) => {
      scheduled.push(ms)
      const id = ++seq
      jobs.set(id, { fn, runAt: now + ms })
      return id
    },
    clearTimeoutImpl: (id) => jobs.delete(id),
    fireNext: () => {
      let pick = null
      let pickId = null
      for (const [id, j] of jobs) {
        if (!pick || j.runAt < pick.runAt) {
          pick = j
          pickId = id
        }
      }
      if (!pick) throw new Error('scheduler: 没有待触发任务')
      now = pick.runAt
      jobs.delete(pickId)
      pick.fn()
    },
  }
}

function makeConn(opts = {}) {
  const frames = []
  const statuses = []
  const conn = createBotConnection({
    url: opts.url || 'ws://test',
    storedNick: opts.storedNick ?? null,
    WebSocketImpl: opts.WebSocketImpl || MockSocket,
    onFrame: (f) => frames.push(f),
    onStatus: (s) => statuses.push(s),
    setTimeoutImpl: opts.setTimeoutImpl,
    clearTimeoutImpl: opts.clearTimeoutImpl,
  })
  return { conn, frames, statuses }
}

describe('createBotConnection', () => {
  beforeEach(() => {
    MockSocket.instances = []
    StubSocket.instances = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect: URL 带 ?nick=ANON-XXXX（storedNick 合法时）；open 后自动发 {type:"join",roomId}', async () => {
    vi.useFakeTimers()
    const { conn, statuses } = makeConn({ storedNick: 'ANON-7K2Q' })
    conn.connect('setsubun')
    expect(statuses).toEqual(['connecting'])
    expect(conn.currentRoomId).toBe('setsubun')
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses).toEqual(['connecting', 'open'])
    const s = lastSocket()
    expect(s.url).toBe('ws://test?nick=ANON-7K2Q')
    expect(framesOf(s)).toEqual([{ type: 'join', roomId: 'setsubun' }])
  })

  it('storedNick 为 null/非法格式 → 不带 nick 参数（让服务器随机分配）', async () => {
    vi.useFakeTimers()
    const a = makeConn() // storedNick 缺省 null
    a.conn.connect('r1')
    expect(MockSocket.instances[0].url).toBe('ws://test')
    const b = makeConn({ storedNick: 'ANON-I0O1' }) // 含被剔除的 O/I/0/1 → 非法
    b.conn.connect('r1')
    expect(MockSocket.instances[1].url).toBe('ws://test')
    const c = makeConn({ storedNick: 'not-anon' })
    c.conn.connect('r1')
    expect(MockSocket.instances[2].url).toBe('ws://test')
  })

  it('非用户 close 的断开 → 按 1000/2000/5000 退避重连，重连 open 后自动 rejoin 断线前房间（B11）', () => {
    expect(BOT_BACKOFF).toEqual([1000, 2000, 5000])
    const sch = makeScheduler()
    const { conn, statuses } = makeConn({ WebSocketImpl: StubSocket, ...sch })
    conn.connect('roomA')
    StubSocket.instances[0].open()
    expect(framesOf(StubSocket.instances[0])).toEqual([{ type: 'join', roomId: 'roomA' }])

    // 连续 4 次异常断开都发生在到达 open 之前 → 计数器不重置，档位逐进并封顶
    StubSocket.instances[0].fail(1006)
    sch.fireNext() // → stub2
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting'])
    StubSocket.instances[1].fail(1006)
    sch.fireNext() // → stub3
    StubSocket.instances[2].fail(1006)
    sch.fireNext() // → stub4
    StubSocket.instances[3].fail(1006)
    expect(sch.scheduled).toEqual([1000, 2000, 5000, 5000]) // 第 4 档停留封顶 5000

    // 第 5 次重连成功 open → 自动 rejoin 断线前房间（currentRoomId），且计数器归零
    sch.fireNext() // → stub5
    StubSocket.instances[4].open()
    expect(framesOf(StubSocket.instances[4])).toEqual([{ type: 'join', roomId: 'roomA' }])
    StubSocket.instances[4].fail(1006)
    expect(sch.scheduled[4]).toBe(1000) // open 归零：下次退避重新从 1000 起步

    // close() 清掉挂起的退避任务
    conn.close()
    expect(sch.pending()).toBe(0)
    expect(statuses[statuses.length - 1]).toBe('closed')
  })

  it('switchRoom: open 时立即发 join 新房；closed 时记住、下次 open 再 join', async () => {
    vi.useFakeTimers()
    const { conn } = makeConn()
    conn.connect('roomA')
    await vi.advanceTimersByTimeAsync(0)
    const s1 = lastSocket()
    expect(framesOf(s1)).toEqual([{ type: 'join', roomId: 'roomA' }])

    // open 态：立即 join
    conn.switchRoom('roomB')
    expect(framesOf(s1)).toEqual([
      { type: 'join', roomId: 'roomA' },
      { type: 'join', roomId: 'roomB' },
    ])

    // 断开（非用户）→ closed 态切房只记账；下次 open 自动 join 新房
    s1.close()
    conn.switchRoom('roomC')
    expect(conn.currentRoomId).toBe('roomC')
    await vi.advanceTimersByTimeAsync(999)
    await vi.advanceTimersByTimeAsync(1) // 创建 s2
    // s2 的 open 定时器是在上一次推进回调执行中途排下的（callAt==当时 now），
    // vitest 的 advanceTimersByTimeAsync(0) 不会补触发同刻 timer——再多推 1ms 越过它
    await vi.advanceTimersByTimeAsync(1)
    const s2 = lastSocket()
    expect(framesOf(s2)).toEqual([{ type: 'join', roomId: 'roomC' }])
  })

  it('close() 后不再重连（closedByUser 语义）；send 在非 open 态返回 false 不抛', async () => {
    vi.useFakeTimers()
    const { conn, statuses } = makeConn()
    // 从未连接：send false 不抛；close 也安全。onStatus 采用「仅变化才通知」语义
    // （镜像 useChat 的 ref 赋值去重），此时保持安静
    expect(conn.send({ type: 'message', text: 'hi', badge: '' })).toBe(false)
    expect(() => conn.close()).not.toThrow()
    expect(statuses).toEqual([])

    conn.connect('roomA')
    expect(conn.send({ type: 'message', text: 'x' })).toBe(false) // connecting 态
    await vi.advanceTimersByTimeAsync(0)
    expect(conn.send({ type: 'message', text: 'hi', badge: '' })).toBe(true)
    const s = lastSocket()
    expect(framesOf(s)).toEqual([
      { type: 'join', roomId: 'roomA' },
      { type: 'message', text: 'hi', badge: '' },
    ])

    conn.close()
    expect(statuses).toEqual(['connecting', 'open', 'closed'])
    expect(conn.send({ type: 'message', text: 'nope' })).toBe(false) // closed 态
    const n = MockSocket.instances.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(MockSocket.instances).toHaveLength(n) // 不再重连

    // 场景二：非用户断开已排好退避，再 close() → 清掉挂起定时器
    const c2 = makeConn()
    c2.conn.connect('roomA')
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().close() // 排 1000ms 重连
    const m = MockSocket.instances.length
    c2.conn.close()
    await vi.advanceTimersByTimeAsync(60000)
    expect(MockSocket.instances).toHaveLength(m)
  })

  it('stale-socket 竞态：close() 后旧 socket 迟到的 open/close/message 事件不得伤害新连接（审查轮 1）', () => {
    const sch = makeScheduler()
    const { conn, frames, statuses } = makeConn({ WebSocketImpl: StubSocket, ...sch })
    conn.connect('roomA')
    const s1 = StubSocket.instances[0]
    s1.open()
    expect(framesOf(s1)).toEqual([{ type: 'join', roomId: 'roomA' }])

    // 用户 close()：真实 WS 语义下 close 事件迟到（StubSocket.close 不同步派发）
    conn.close()
    expect(s1.closedRequested).toBe(true)
    expect(statuses).toEqual(['connecting', 'open', 'closed'])

    // ① 旧 socket 迟到的 onopen：不得把已关闭连接翻回 open、不得补发 join
    s1.open()
    // ② 立即重连 → s2（connecting）
    conn.connect('roomA')
    const s2 = StubSocket.instances[1]
    expect(StubSocket.instances).toHaveLength(2)
    // ③ 旧 socket 迟到的 onclose：不得清掉 s2 引用、不得翻 'closed'、不得排退避重连
    s1.fail(1000)
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting'])
    expect(sch.scheduled).toEqual([]) // 无重试 timer 排下 → 不会孵出第三条连接
    expect(sch.pending()).toBe(0)
    // ④ s2 未孤儿化：正常 open、join、send 全部落在 s2
    s2.open()
    expect(framesOf(s2)).toEqual([{ type: 'join', roomId: 'roomA' }])
    expect(conn.send({ type: 'message', text: 'live' })).toBe(true)
    expect(framesOf(s2)).toEqual([
      { type: 'join', roomId: 'roomA' },
      { type: 'message', text: 'live' },
    ])
    // ⑤ 旧 socket 在途帧：不得混入 onFrame
    s1.emit({ type: 'message', id: 'ghost', ts: 1, roomId: 'roomA', nick: 'ANON-X', badge: '', text: 'stale' })
    expect(frames).toEqual([])
    // ⑥ 收尾 close()：s2 仍被引用（未 orphan），应收到 close 请求
    conn.close()
    expect(s2.closedRequested).toBe(true)
    expect(StubSocket.instances).toHaveLength(2)
    expect(sch.pending()).toBe(0)
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open', 'closed'])
  })

  it('ws.send 抛错（status=open 但 socket 已 CLOSING 的窗口，InvalidStateError）→ send 返回 false 不抛（终审 #6）', async () => {
    vi.useFakeTimers()
    const { conn } = makeConn()
    conn.connect('roomA')
    await vi.advanceTimersByTimeAsync(0)
    const s = lastSocket()
    // 真实浏览器：readyState 变 CLOSING 与 status 镜像之间存在窗口，send 会抛 DOMException
    s.send = () => { throw new Error('InvalidStateError: WebSocket is already in CLOSING state') }
    expect(() => conn.send({ type: 'message', text: 'x' })).not.toThrow()
    expect(conn.send({ type: 'message', text: 'x' })).toBe(false)
    conn.close()
  })

  it('onFrame 透传 joined/assign/message/rate/join-error 原帧不做加工', async () => {
    vi.useFakeTimers()
    const { conn, frames } = makeConn()
    conn.connect('roomA')
    await vi.advanceTimersByTimeAsync(0)
    const s = lastSocket()
    const samples = [
      { type: 'assign', nick: 'ANON-7K2Q' },
      { type: 'joined', roomId: 'roomA', selfId: 42, online: 3 },
      { type: 'message', id: 'm1', ts: 123, roomId: 'roomA', nick: 'ANON-PEER', badge: '', text: 'hi' },
      { type: 'rate', waitMs: 2000 },
      { type: 'join-error', roomId: 'roomX', reason: 'unknown' },
      { type: 'presence', roomId: 'roomA', online: 2 },
      { type: 'history-req', roomId: 'roomA', from: 9 },
      { type: 'history-res', roomId: 'roomA', messages: [] },
    ]
    for (const f of samples) s.emit(f)
    expect(frames).toEqual(samples) // 原样、按序、不加工
    // 非 JSON 脏帧忽略不抛（镜像 useChat.onmessage）
    expect(() => s.onmessage({ data: 'not-json' })).not.toThrow()
    expect(frames).toHaveLength(samples.length)
  })
})
