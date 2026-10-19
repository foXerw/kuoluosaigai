import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatRoom from '../src/components/ChatRoom.vue'
import RoomDrawer from '../src/components/RoomDrawer.vue'
import RulesModal from '../src/components/RulesModal.vue'
import { CHANNELS } from '../src/theme/channels'
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

const PUBLIC = ['setsubun', 'nebula', 'magenta', 'amber']

// 统一卸载（useChat.test.js 同款模式）：disconnect 清掉重连/历史窗口/notice 定时器，
// 同时摘掉 window keydown 监听并触发色随房的落地色恢复，避免跨用例串扰
const mountedWrappers = []

describe('ChatRoom', () => {
  let channel
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
    sessionStorage.clear()
    localStorage.clear()
    __resetFallbackForTest()
    channel = CHANNELS.find((c) => c.prefix === 'SETSUBUN')
  })
  afterEach(() => {
    while (mountedWrappers.length) {
      try {
        mountedWrappers.pop().unmount()
      } catch {
        // 用例内已手动 unmount
      }
    }
    delete global.WebSocket
    document.documentElement.style.removeProperty('--app-color')
    document.documentElement.style.removeProperty('--app-glow')
  })

  function mountRoom(overrides = {}) {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel, ...overrides } })
    mountedWrappers.push(w)
    return w
  }

  it('shows offline copy and does not connect when url is empty', () => {
    const w = mountRoom({ url: '' })
    expect(w.text()).toContain('channel offline')
    expect(MockSocket.instances).toHaveLength(0)
  })

  it('mount connects and sends a join frame for the channel room', async () => {
    const w = mountRoom()
    await flush()
    // open 后即发出频道 roomId 的 join 帧（v2：连接 ≠ 入房）
    expect(framesOf(MockSocket.instances[0])).toEqual([{ type: 'join', roomId: 'setsubun' }])
    expect(w.text()).toContain('ROOM --') // 尚未 joined：占位
  })

  it('joined frame drives the room indicator and online count; messages render with badge', async () => {
    const w = mountRoom()
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
    expect(w.text()).toContain('ROOM SETSUBUN') // v2：公共房显示频道 prefix
    expect(w.text()).toContain('hello world')
    expect(w.text()).toContain('5 online')
    expect(w.text()).toContain('SETSUBUN')
    w.unmount() // 清掉 online>1 触发的 2s 历史窗口定时器
  })

  it('submits on enter, sends a message frame with badge, and clears the field', async () => {
    const w = mountRoom()
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
    const w = mountRoom()
    await flush()
    await w.find('input').setValue('   ')
    await w.find('form').trigger('submit')
    // 只有 mount 时的 join 帧，没有 message
    expect(framesOf(MockSocket.instances[0])).toEqual([{ type: 'join', roomId: 'setsubun' }])
  })

  it('emits close on close button and on Escape', async () => {
    const w = mountRoom()
    await flush()
    await w.find('.chat__close').trigger('click')
    expect(w.emitted('close')).toBeTruthy()

    const w2 = mountRoom()
    await flush()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w2.emitted('close')).toBeTruthy()
  })

  describe('multi-room integration (Task 10)', () => {
    it('top bar shows channel prefix + color for public rooms, raw id for private', async () => {
      const w = mountRoom()
      await flush()
      const s = MockSocket.instances[0]
      s.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 1 })
      await w.vm.$nextTick()
      const chan = w.find('.chat__chan')
      expect(chan.text()).toContain('ROOM NEBULA')
      // 公共房：指示器带频道色（jsdom 把内联 #22d3ee 归一成 rgb）
      expect(chan.element.style.color).toBe('rgb(34, 211, 238)')

      s.emit({ type: 'joined', roomId: 'abc123', online: 1, selfId: 1 })
      await w.vm.$nextTick()
      const priv = w.find('.chat__chan')
      expect(priv.text()).toContain('ROOM abc123') // 私房：原始 id
      expect(priv.element.style.color).toBe('') // 私房：默认色（无内联覆盖）
    })

    it('[ROOMS] opens RoomDrawer inside the ChatRoom root with props wired; [RULES] opens RulesModal', async () => {
      const w = mountRoom()
      await flush()
      expect(w.findComponent(RoomDrawer).exists()).toBe(false)
      expect(w.findComponent(RulesModal).exists()).toBe(false)

      await w.find('.chat__btn--rooms').trigger('click')
      const drawer = w.findComponent(RoomDrawer)
      expect(drawer.exists()).toBe(true)
      // R4：抽屉必须挂在 ChatRoom 根（z:100 stacking context）内部，否则会被整屏盖住
      expect(w.element.contains(drawer.element)).toBe(true)
      expect(drawer.props('rooms')).toEqual(PUBLIC)
      expect(drawer.props('current')).toBe('') // currentRoom null → ''（prop 是 String，避免 dev warning）
      expect(drawer.props('counts')).toEqual({})
      expect(drawer.props('notice')).toBe('')

      // joinNotice 直通抽屉 notice
      const s = MockSocket.instances[0]
      s.emit({ type: 'join-error', reason: 'unknown' })
      await w.vm.$nextTick()
      expect(drawer.props('notice')).toBe('NO SUCH ROOM')

      await w.find('.chat__btn--rules').trigger('click')
      const rules = w.findComponent(RulesModal)
      expect(rules.exists()).toBe(true)
      expect(w.element.contains(rules.element)).toBe(true)
      expect(w.text()).toContain('RULES')
      await w.find('.rules__close').trigger('click')
      expect(w.findComponent(RulesModal).exists()).toBe(false)
    })

    it('Esc priority: rules first, then drawer, then close', async () => {
      const w = mountRoom()
      await flush()
      await w.find('.chat__btn--rooms').trigger('click')
      await w.find('.chat__btn--rules').trigger('click')
      expect(w.findComponent(RulesModal).exists()).toBe(true)
      expect(w.findComponent(RoomDrawer).exists()).toBe(true)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await w.vm.$nextTick()
      expect(w.findComponent(RulesModal).exists()).toBe(false) // 规则开着 → 只关规则
      expect(w.findComponent(RoomDrawer).exists()).toBe(true)
      expect(w.emitted('close')).toBeFalsy()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await w.vm.$nextTick()
      expect(w.findComponent(RoomDrawer).exists()).toBe(false) // 抽屉开着 → 只关抽屉
      expect(w.emitted('close')).toBeFalsy()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await w.vm.$nextTick()
      expect(w.emitted('close')).toBeTruthy() // 都关着 → 关聊天
    })

    it('drawer join/create events drive socket frames', async () => {
      const w = mountRoom()
      await flush()
      const s = MockSocket.instances[0]
      await w.find('.chat__btn--rooms').trigger('click')
      const drawer = w.findComponent(RoomDrawer)
      drawer.vm.$emit('join', 'abc123')
      drawer.vm.$emit('create')
      expect(framesOf(s)).toEqual([
        { type: 'join', roomId: 'setsubun' },
        { type: 'counts', roomIds: PUBLIC }, // 在线打开抽屉 → refreshCounts
        { type: 'join', roomId: 'abc123' },
        { type: 'create' },
      ])
    })

    it('drawer remove drops the room from list, storage and cache', async () => {
      const w = mountRoom()
      await flush()
      const s = MockSocket.instances[0]
      s.emit({ type: 'joined', roomId: 'abc123', online: 1, selfId: 1 })
      s.emit({ type: 'message', id: 'm1', ts: 1, roomId: 'abc123', nick: 'ANON-PEER', badge: '', text: 'kept?' })
      await w.vm.$nextTick()
      await w.find('.chat__btn--rooms').trigger('click')
      const drawer = w.findComponent(RoomDrawer)
      expect(drawer.props('rooms')).toContain('abc123')
      expect(w.vm.cache.get('abc123')).toHaveLength(1) // 前置：缓存里确实有货

      drawer.vm.$emit('remove', 'abc123')
      await w.vm.$nextTick()
      expect(drawer.props('rooms')).not.toContain('abc123')
      expect(w.vm.cache.get('abc123')).toEqual([]) // Task 7 removeRoom 贯通：缓存同删
      expect(JSON.parse(localStorage.getItem('kuoluosaigai:rooms'))).not.toContain('abc123')
    })

    it('color follows room: channel color for public, base default for private, landing color on unmount', async () => {
      const w = mountRoom() // 落地 setsubun（#39ff14）
      await flush()
      const s = MockSocket.instances[0]
      s.emit({ type: 'joined', roomId: 'nebula', online: 1, selfId: 1 })
      await w.vm.$nextTick()
      expect(document.documentElement.style.getPropertyValue('--app-color')).toBe('#22d3ee')
      expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe('#22d3ee')

      s.emit({ type: 'joined', roomId: 'abc123', online: 1, selfId: 1 })
      await w.vm.$nextTick()
      // 私房：内联覆盖被移除 → 基础样式 :root 的默认绿 #39ff14 生效（jsdom 不加载 CSS，断言内联为空）
      expect(document.documentElement.style.getPropertyValue('--app-color')).toBe('')
      expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe('')

      w.unmount()
      // 卸载恢复落地频道色（setsubun = #39ff14；若误用 removeProperty 这里会是 ''）
      expect(document.documentElement.style.getPropertyValue('--app-color')).toBe('#39ff14')
      expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe('#39ff14')
    })

    it('unmount restores the landing channel color, not a hardcoded green', async () => {
      const nebula = CHANNELS.find((c) => c.prefix === 'NEBULA')
      const w = mountRoom({ channel: nebula })
      await flush()
      const s = MockSocket.instances[0]
      s.emit({ type: 'joined', roomId: 'magenta', online: 1, selfId: 1 })
      await w.vm.$nextTick()
      expect(document.documentElement.style.getPropertyValue('--app-color')).toBe('#ff2d95')
      w.unmount()
      expect(document.documentElement.style.getPropertyValue('--app-color')).toBe('#22d3ee')
      expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe('#22d3ee')
    })

    it('opening the drawer refreshes counts each time while connected', async () => {
      const w = mountRoom()
      await flush()
      const s = MockSocket.instances[0]
      await w.find('.chat__btn--rooms').trigger('click')
      expect(framesOf(s).at(-1)).toEqual({ type: 'counts', roomIds: PUBLIC })
      // 关上再开 → 再来一帧 counts
      await w.find('.chat__btn--rooms').trigger('click')
      await w.find('.chat__btn--rooms').trigger('click')
      expect(framesOf(s).filter((f) => f.type === 'counts')).toHaveLength(2)
    })

    it('offline (R5): drawer opens silently with disabled foot class; rows and remove still work', async () => {
      localStorage.setItem('kuoluosaigai:rooms', JSON.stringify(['abc123']))
      const w = mountRoom({ url: '' })
      expect(MockSocket.instances).toHaveLength(0)
      await w.find('.chat__btn--rooms').trigger('click')
      const drawer = w.findComponent(RoomDrawer)
      expect(drawer.exists()).toBe(true)
      // 包装类挂钩：ChatRoom 用 :deep() CSS 把底部输入/NEW 置灰禁点（jsdom 只钉类名）
      expect(drawer.classes()).toContain('chat__drawer--offline')
      expect(drawer.props('rooms')).toEqual([...PUBLIC, 'abc123'])
      expect(MockSocket.instances).toHaveLength(0) // 离线打开抽屉不发任何帧（无 counts）

      // removeRoom 是纯本地操作：离线仍可删
      await drawer.find('.drawer__remove').trigger('click')
      expect(drawer.props('rooms')).not.toContain('abc123')
      expect(JSON.parse(localStorage.getItem('kuoluosaigai:rooms'))).not.toContain('abc123')

      // 在线时抽屉不带 offline 类
      const w2 = mountRoom()
      await flush()
      await w2.find('.chat__btn--rooms').trigger('click')
      expect(w2.findComponent(RoomDrawer).classes()).not.toContain('chat__drawer--offline')
    })
  })
})
