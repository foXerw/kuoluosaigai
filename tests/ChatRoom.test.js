import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatRoom from '../src/components/ChatRoom.vue'
import { CHANNELS } from '../src/theme/channels'

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

describe('ChatRoom', () => {
  let channel
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
    sessionStorage.clear()
    localStorage.clear()
    channel = CHANNELS.find((c) => c.prefix === 'SETSUBUN')
  })
  afterEach(() => {
    delete global.WebSocket
  })

  it('shows offline copy and does not connect when url is empty', () => {
    const w = mount(ChatRoom, { props: { url: '', channel } })
    expect(w.text()).toContain('channel offline')
    expect(MockSocket.instances).toHaveLength(0)
  })

  it('mount connects and sends a join frame for the channel room', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    // open 后即发出频道 roomId 的 join 帧（v2：连接 ≠ 入房）
    expect(framesOf(MockSocket.instances[0])).toEqual([{ type: 'join', roomId: 'setsubun' }])
    expect(w.text()).toContain('ROOM --') // 尚未 joined：占位
  })

  it('joined frame drives the room indicator and online count; messages render with badge', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    const s = MockSocket.instances[0]
    s.emit({ type: 'joined', roomId: 'setsubun', online: 5, selfId: 1 })
    s.emit({
      type: 'message',
      id: 'x1',
      ts: Date.now(),
      roomId: 'setsubun',
      nick: 'ANON-7K2Q',
      badge: 'SETSUBUN',
      text: 'hello world',
    })
    await w.vm.$nextTick()
    expect(w.text()).toContain('connected')
    expect(w.text()).toContain('ROOM setsubun')
    expect(w.text()).toContain('hello world')
    expect(w.text()).toContain('5 online')
    expect(w.text()).toContain('SETSUBUN')
    w.unmount() // 清掉 online>1 触发的 2s 历史窗口定时器
  })

  it('submits on enter, sends a message frame with badge, and clears the field', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    const s = MockSocket.instances[0]
    await w.find('input').setValue('hi there')
    await w.find('form').trigger('submit')
    const sent = framesOf(s)
    expect(sent[0]).toEqual({ type: 'join', roomId: 'setsubun' })
    expect(sent[1]).toEqual({ type: 'message', text: 'hi there', badge: 'SETSUBUN' })
    expect(w.find('input').element.value).toBe('')
  })

  it('does not send empty input', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    await w.find('input').setValue('   ')
    await w.find('form').trigger('submit')
    // 只有 mount 时的 join 帧，没有 message
    expect(framesOf(MockSocket.instances[0])).toEqual([{ type: 'join', roomId: 'setsubun' }])
  })

  it('emits close on close button and on Escape', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    await w.find('.chat__close').trigger('click')
    expect(w.emitted('close')).toBeTruthy()

    const w2 = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w2.emitted('close')).toBeTruthy()
  })
})
