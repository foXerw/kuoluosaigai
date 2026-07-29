import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useChat } from '../src/composables/useChat'

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

function mountChat(url = 'ws://test', badge = 'SETSUBUN') {
  const Comp = defineComponent({
    setup() {
      const c = useChat(url, badge)
      return { c }
    },
    render() {
      return h('div')
    },
  })
  return mount(Comp)
}

describe('useChat', () => {
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete global.WebSocket
  })

  it('connects, goes open, and stores assigned nick', async () => {
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    expect(w.vm.c.status.value).toBe('open')
    MockSocket.instances[0].emit({ type: 'assign', nick: 'ANON-7K2' })
    expect(w.vm.c.nick.value).toBe('ANON-7K2')
  })

  it('updates online and appends message/join/leave/rate frames', async () => {
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    const s = MockSocket.instances[0]
    s.emit({ type: 'presence', online: 3 })
    expect(w.vm.c.online.value).toBe(3)
    s.emit({ type: 'message', nick: 'X', badge: 'SETSUBUN', text: 'hi', ts: 1 })
    s.emit({ type: 'join', nick: 'Y', ts: 2 })
    s.emit({ type: 'rate', ts: 3 })
    s.emit({ type: 'leave', nick: 'Y', ts: 4 })
    expect(w.vm.c.messages.value).toHaveLength(4)
  })

  it('send posts a message frame with badge only when open', async () => {
    const w = mountChat()
    w.vm.c.send('no') // closed -> no socket
    expect(MockSocket.instances).toHaveLength(0)
    w.vm.c.connect()
    await flush()
    const s = MockSocket.instances[0]
    w.vm.c.send('hello')
    expect(s.sent).toHaveLength(1)
    expect(JSON.parse(s.sent[0])).toEqual({ type: 'message', text: 'hello', badge: 'SETSUBUN' })
  })

  it('reconnects with backoff after an unexpected close', async () => {
    vi.useFakeTimers()
    const w = mountChat()
    w.vm.c.connect()
    await vi.advanceTimersByTimeAsync(0) // flush open
    expect(MockSocket.instances).toHaveLength(1)
    MockSocket.instances[0].close() // schedules reconnect(1000ms)
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockSocket.instances).toHaveLength(2)
    w.unmount()
  })

  it('disconnect on unmount closes the socket and prevents further reconnects', async () => {
    vi.useFakeTimers()
    const w = mountChat()
    w.vm.c.connect()
    await vi.advanceTimersByTimeAsync(0)
    const s = MockSocket.instances[0]
    const closeSpy = vi.spyOn(s, 'close')
    w.unmount()
    expect(closeSpy).toHaveBeenCalled()
    const count = MockSocket.instances.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(MockSocket.instances.length).toBe(count)
  })

  it('persists the assigned nick to sessionStorage', async () => {
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    MockSocket.instances[0].emit({ type: 'assign', nick: 'ANON-7K2' })
    expect(w.vm.c.nick.value).toBe('ANON-7K2')
    expect(sessionStorage.getItem('kuoluosaigai:nick')).toBe('ANON-7K2')
  })

  it('sends the stored nick as a query param on connect', async () => {
    sessionStorage.setItem('kuoluosaigai:nick', 'ANON-ABCD')
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    expect(MockSocket.instances[0].url).toContain('nick=ANON-ABCD')
  })

  it('keeps the same nick across a reconnect', async () => {
    vi.useFakeTimers()
    const w = mountChat()
    w.vm.c.connect()
    await vi.advanceTimersByTimeAsync(0) // flush open
    MockSocket.instances[0].emit({ type: 'assign', nick: 'ANON-KEEP' })
    MockSocket.instances[0].close() // schedules reconnect(1000ms)
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockSocket.instances).toHaveLength(2)
    expect(MockSocket.instances[1].url).toContain('nick=ANON-KEEP')
    w.unmount()
  })

  it('ignores a malformed stored nick and connects clean', async () => {
    sessionStorage.setItem('kuoluosaigai:nick', '<script>')
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    expect(MockSocket.instances[0].url).not.toContain('nick=')
  })
})
