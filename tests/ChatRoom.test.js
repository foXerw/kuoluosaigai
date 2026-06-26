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

describe('ChatRoom', () => {
  let channel
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
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

  it('renders connected status, online count, and messages with badge', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    expect(w.text()).toContain('connected')
    const s = MockSocket.instances[0]
    s.emit({ type: 'presence', online: 5 })
    s.emit({ type: 'message', nick: 'ANON-7K2', badge: 'SETSUBUN', text: 'hello world', ts: Date.now() })
    await w.vm.$nextTick()
    expect(w.text()).toContain('hello world')
    expect(w.text()).toContain('5 online')
    expect(w.text()).toContain('SETSUBUN')
  })

  it('submits on enter, sends a message frame with badge, and clears the field', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    const s = MockSocket.instances[0]
    await w.find('input').setValue('hi there')
    await w.find('form').trigger('submit')
    expect(s.sent).toHaveLength(1)
    const sent = JSON.parse(s.sent[0])
    expect(sent.type).toBe('message')
    expect(sent.text).toBe('hi there')
    expect(sent.badge).toBe('SETSUBUN')
    expect(w.find('input').element.value).toBe('')
  })

  it('does not send empty input', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    await w.find('input').setValue('   ')
    await w.find('form').trigger('submit')
    expect(MockSocket.instances[0].sent).toHaveLength(0)
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
