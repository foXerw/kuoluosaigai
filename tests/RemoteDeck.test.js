import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RemoteDeck from '../src/components/RemoteDeck.vue'

function makeStore(over = {}) {
  return {
    devices: [],
    selectedId: null,
    selectedDevice: null,
    status: 'idle',
    online: false,
    bots: [],
    providers: [],
    sessions: [],
    notice: '',
    pair: vi.fn(async () => ({ deviceId: 'd1', name: 'lab-vm' })),
    select: vi.fn(),
    removeDevice: vi.fn(),
    startBot: vi.fn(async () => ({ ok: true, err: null })),
    stopBot: vi.fn(async () => ({ ok: true, err: null })),
    switchRoom: vi.fn(async () => ({ ok: true, err: null })),
    clearBuffer: vi.fn(async () => ({ ok: true, err: null })),
    updateBot: vi.fn(async () => ({ ok: true, err: null })),
    removeBot: vi.fn(async () => ({ ok: true, err: null })),
    addBot: vi.fn(async () => ({ ok: true, err: null })),
    refreshSessions: vi.fn(async () => []),
    revokeSession: vi.fn(async () => ({ ok: true, err: null })),
    ...over,
  }
}

const bot = {
  id: 'b1', name: '小李', persona: '毒舌', chattiness: 60, temperature: 1, model: 'm',
  providerId: 'daemon', room: 'nebula', status: 'stopped', nick: 'ANON-A',
  hourCount: 2, session: { promptTokens: 1, completionTokens: 2, messages: 3 }, lifetime: {},
}

describe('RemoteDeck', () => {
  it('无设备：显示配对表单；提交调用 pair，且没有 key 输入框', async () => {
    const store = makeStore()
    const w = mount(RemoteDeck, { props: { store } })
    expect(w.text()).toContain('PAIR DEVICE')
    expect(w.find('input[type="password"]').exists()).toBe(false)
    await w.find('.remote__code').setValue('ABC234')
    await w.find('.remote__pform').trigger('submit')
    expect(store.pair).toHaveBeenCalledWith('ABC234', 'browser')
  })

  it('有设备：设备按钮调用 select；在线态与 keyHint 展示，不含完整 key', async () => {
    const store = makeStore({
      devices: [{ deviceId: 'd1', name: 'lab-vm' }],
      selectedId: 'd1',
      selectedDevice: { deviceId: 'd1', name: 'lab-vm' },
      status: 'open',
      online: true,
      providers: [{ id: 'daemon', name: 'daemon', baseUrl: 'https://api', keyHint: '****cdef' }],
    })
    const w = mount(RemoteDeck, { props: { store } })
    expect(w.text()).toContain('lab-vm')
    expect(w.text()).toContain('daemon 在线')
    expect(w.text()).toContain('****cdef')
    expect(w.text()).not.toContain('sk-')
    await w.find('.remote__device').trigger('click')
    expect(store.select).toHaveBeenCalledWith('d1')
  })

  it('bots 映射到 BotCard：启动/切房/删除/编辑（过滤 apiKey）', async () => {
    const store = makeStore({
      devices: [{ deviceId: 'd1', name: 'lab-vm' }],
      selectedId: 'd1',
      selectedDevice: { deviceId: 'd1', name: 'lab-vm' },
      status: 'open',
      online: true,
      bots: [bot],
      providers: [{ id: 'daemon', name: 'daemon', baseUrl: 'https://api', keyHint: '****cdef' }],
    })
    const w = mount(RemoteDeck, { props: { store } })
    const card = w.findComponent({ name: 'BotCard' })
    expect(card.props('bot')).toMatchObject({ id: 'b1', roomId: 'nebula', persona: '毒舌' })
    expect(card.props('showWatch')).toBe(false)

    await card.find('.bot-card__start').trigger('click')
    expect(store.startBot).toHaveBeenCalledWith('b1')

    // apiKey 即使混进 patch 也必须被过滤，不能进 dev-cmd
    w.vm.update('b1', { persona: '新', apiKey: 'sk-secret' })
    expect(store.updateBot).toHaveBeenCalledWith('b1', { persona: '新' })
  })

  it('会话列表：刷新与撤销', async () => {
    const store = makeStore({
      devices: [{ deviceId: 'd1', name: 'lab-vm' }],
      selectedId: 'd1',
      selectedDevice: { deviceId: 'd1', name: 'lab-vm' },
      status: 'open',
      online: true,
      sessions: [{ sessionId: 's1', label: 'Phone', online: true }],
    })
    const w = mount(RemoteDeck, { props: { store } })
    await w.find('.remote__refresh').trigger('click')
    expect(store.refreshSessions).toHaveBeenCalled()
    await w.find('.remote__revoke').trigger('click')
    expect(store.revokeSession).toHaveBeenCalledWith('s1')
  })

  it('运行时修改提示在场；远端新增 bot 提示需要本机 key', async () => {
    const store = makeStore({
      devices: [{ deviceId: 'd1', name: 'lab-vm' }],
      selectedId: 'd1',
      selectedDevice: { deviceId: 'd1', name: 'lab-vm' },
      status: 'open',
      online: true,
    })
    const w = mount(RemoteDeck, { props: { store } })
    expect(w.text()).toContain('运行时修改')
    expect(w.text()).toContain('API key 永不进中继')
    expect(w.text()).toContain('需在 daemon 本机配置')
  })
})
