// Task 9 / spec §8.4 —— BotDeck 面板契约（brief Step 1 四条全落实）。
// 真 createBotStore + deps.createRunner 桩；storage 用默认 jsdom localStorage——
// otherTab 刷新路径 = 组件监听 'storage'(LEASE_KEY) 后轻查本机租约表（store 未暴露刷新方法）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BotDeck from '../src/components/BotDeck.vue'
import BotCard from '../src/components/BotCard.vue'
import { createBotStore, MAX_BOTS, PROVIDER_PRESETS } from '../src/bots/store'
import { LEASE_KEY } from '../src/bots/lease'

function makeRunnerStub() {
  const byBot = new Map()
  const factory = (opts) => {
    const r = {
      opts,
      start() {},
      stop() { opts.onEvent('stopped', null) },
      switchRoom() {},
      clearBuffer() {},
      getBuffer() { return [] },
      pokeIdle() {},
      idleEligible() { return false },
      idleRoll() { return false },
    }
    byBot.set(opts.bot.id, r)
    return r
  }
  return { factory, byBot }
}

const disposables = []
beforeEach(() => {
  localStorage.clear() // 清掉上一用例 store 落盘/租约表残留
})
afterEach(() => {
  while (disposables.length) disposables.pop().dispose()
  localStorage.clear()
})

function setup() {
  const runnerStub = makeRunnerStub()
  const store = createBotStore({
    wsUrl: 'ws://test',
    rng: () => 0.5,
    deps: { tabId: 'tab-A', createRunner: runnerStub.factory, sleep: () => Promise.resolve() },
  })
  disposables.push(store)
  const w = mount(BotDeck, { props: { store } })
  return { store, w, runnerStub }
}

describe('BotDeck', () => {
  it('providers：选预设自动填 baseUrl；key 输入 type=password；添加后出现在列表', async () => {
    const { store, w } = setup()
    const presets = w.findAll('.deck__preset')
    expect(presets).toHaveLength(PROVIDER_PRESETS.length)
    await presets[0].trigger('click') // DeepSeek
    expect(w.find('.deck__name-input').element.value).toBe('DeepSeek')
    expect(w.find('.deck__baseurl-input').element.value).toBe('https://api.deepseek.com')
    const key = w.find('.deck__key-input')
    expect(key.attributes('type')).toBe('password')
    await key.setValue('sk-abc123')
    expect(w.text()).toContain('token 只存本机浏览器') // 明文警告文案在场
    await w.find('.deck__prov-add').trigger('click')
    expect(store.providers).toHaveLength(1)
    expect(store.providers[0].name).toBe('DeepSeek')
    expect(store.providers[0].apiKey).toBe('sk-abc123')
    expect(w.text()).toContain('DeepSeek')
    expect(w.text()).not.toContain('sk-abc123') // 列表行不回显 key（B9）
  })

  it('新建 bot：填 name/persona/chattiness/provider/model/roomId 提交 → store.bots+1；第 6 个 → 显示 MAX 提示', async () => {
    const { store, w } = setup()
    store.addProvider({ name: 'P1', baseUrl: 'https://x.test', apiKey: 'k' })
    await w.find('.deck__bot-name-input').setValue('黑')
    await w.find('.deck__persona-input').setValue('网络嘴替')
    await w.find('.deck__chattiness-input').setValue('80')
    await w.find('.deck__provider-select').setValue(store.providers[0].id)
    await w.find('.deck__model-input').setValue('some-model')
    await w.find('.deck__room-input').setValue('nebula')
    await w.find('.deck__create').trigger('click')
    expect(store.bots).toHaveLength(1)
    const b = store.bots[0]
    expect(b.name).toBe('黑')
    expect(b.persona).toBe('网络嘴替')
    expect(b.chattiness).toBe(80)
    expect(b.providerId).toBe(store.providers[0].id)
    expect(b.model).toBe('some-model')
    expect(b.roomId).toBe('nebula')
    // 顶格 5 个 → MAX 提示 + 提交不加
    for (let i = 0; i < 5; i++) store.addBot({ name: `x${i}`, roomId: 'setsubun' })
    expect(store.bots).toHaveLength(MAX_BOTS)
    await w.find('.deck__bot-name-input').setValue('第六个')
    await w.find('.deck__room-input').setValue('amber')
    await w.find('.deck__create').trigger('click')
    expect(w.text()).toContain('MAX')
    expect(store.bots).toHaveLength(MAX_BOTS)
  })

  it('卡片操作接线 store：start → store.startBot；update → store.updateBot', async () => {
    const { store, w, runnerStub } = setup()
    store.addProvider({ name: 'P1', baseUrl: 'https://x.test', apiKey: 'k' })
    store.addBot({ name: '美', roomId: 'setsubun', providerId: store.providers[0].id })
    await w.vm.$nextTick()
    const bot = store.bots[0]
    const card = w.findComponent(BotCard)
    expect(card.exists()).toBe(true)
    card.vm.$emit('start')
    await new Promise((r) => setTimeout(r, 0)) // flush startBot 内 lease.acquire 的微任务
    expect(bot.rt.status).toBe('connecting')
    expect(runnerStub.byBot.get(bot.id)).toBeTruthy()
    card.vm.$emit('update', { name: '良' })
    expect(bot.name).toBe('良')
  })

  it('storage 事件（key=LEASE_KEY）→ otherTab 状态刷新', async () => {
    const { store, w } = setup()
    store.addBot({ name: 'A', roomId: 'setsubun' })
    const id = store.bots[0].id
    localStorage.setItem(LEASE_KEY, JSON.stringify({ [id]: { tabId: 'tab-B', ts: Date.now() } }))
    window.dispatchEvent(new StorageEvent('storage', { key: LEASE_KEY }))
    await w.vm.$nextTick()
    expect(store.bots[0].rt.otherTab).toBe(true)
    expect(w.text()).toContain('在另一标签运行中')
    // 租约条目消失 → 刷新回 false
    localStorage.setItem(LEASE_KEY, JSON.stringify({}))
    window.dispatchEvent(new StorageEvent('storage', { key: LEASE_KEY }))
    await w.vm.$nextTick()
    expect(store.bots[0].rt.otherTab).toBe(false)
    // 竞态回归（审查轮 1 Finding #1）：本 tab 自己的条目（acquire 窗口期自写）绝不误标
    localStorage.setItem(LEASE_KEY, JSON.stringify({ [id]: { tabId: 'tab-A', ts: Date.now() } }))
    window.dispatchEvent(new StorageEvent('storage', { key: LEASE_KEY }))
    await w.vm.$nextTick()
    expect(store.bots[0].rt.otherTab).toBe(false)
    localStorage.setItem(LEASE_KEY, JSON.stringify({}))
    // 无关 key 的事件 → 不动
    localStorage.setItem(LEASE_KEY, JSON.stringify({ [id]: { tabId: 'tab-B', ts: Date.now() } }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'something:else' }))
    await w.vm.$nextTick()
    expect(store.bots[0].rt.otherTab).toBe(false)
  })

  it('新建表单 temperature 默认 0.9（终审 M1 / spec §7）', () => {
    const { w } = setup()
    expect(w.vm.form.temperature).toBe(0.9)
  })

  it('打开面板即查租约（终审 #8）：挂载时 refreshLeases，无需 storage 事件即可复位过期 otherTab', async () => {
    const { store, w } = setup()
    store.addBot({ name: 'A', roomId: 'setsubun' })
    await w.vm.$nextTick()
    const id = store.bots[0].id
    localStorage.setItem(LEASE_KEY, JSON.stringify({ [id]: { tabId: 'tab-B', ts: Date.now() } }))
    w.unmount() // 面板关着时他 tab 写入——本 tab 错过 storage 事件

    const w2 = mount(BotDeck, { props: { store } }) // 重新打开
    expect(store.bots[0].rt.otherTab).toBe(true) // 修复前：挂载不查，永挂 false → 双开烧 token
    localStorage.setItem(LEASE_KEY, JSON.stringify({})) // 他 tab 已停、条目消失
    w2.unmount()
    const w3 = mount(BotDeck, { props: { store } })
    expect(store.bots[0].rt.otherTab).toBe(false) // 打开同样复位（启动钮解禁）
    w3.unmount()
  })

  it('provider 行尾 ✕：未被引用 → removeProvider 删除；被 bot 引用 → 拒删并提示（终审 #9）', async () => {
    const { store, w } = setup()
    const p1 = store.addProvider({ name: 'P1', baseUrl: 'https://x1.test', apiKey: 'k' }).provider
    const p2 = store.addProvider({ name: 'P2', baseUrl: 'https://x2.test', apiKey: 'k' }).provider
    store.addBot({ name: 'A', roomId: 'setsubun', providerId: p2.id })
    await w.vm.$nextTick()
    expect(w.findAll('.deck__prov-del')).toHaveLength(2)
    expect(store.providers.map((x) => x.id)).toEqual([p1.id, p2.id]) // 行序 = 渲染序

    await w.findAll('.deck__prov-del')[0].trigger('click') // P1 未被引用 → 删
    expect(store.providers.map((x) => x.id)).toEqual([p2.id])
    expect(store.bots[0].providerId).toBe(p2.id)

    await w.findAll('.deck__prov-del')[0].trigger('click') // P2 被 bot 引用 → 拒删 + 提示
    expect(store.providers).toHaveLength(1)
    expect(w.text()).toContain('被 bot 引用')

    store.removeBot(store.bots[0].id) // 引用解除后可删，提示同步消失
    await w.vm.$nextTick()
    await w.findAll('.deck__prov-del')[0].trigger('click')
    expect(store.providers).toHaveLength(0)
    expect(w.text()).not.toContain('被 bot 引用')
  })

  it('Esc/关闭按钮 → emit close；unmount 后监听器移除', async () => {
    const runnerStub = makeRunnerStub()
    const store = createBotStore({
      wsUrl: 'ws://test',
      rng: () => 0.5,
      deps: { tabId: 'tab-A', createRunner: runnerStub.factory, sleep: () => Promise.resolve() },
    })
    disposables.push(store)
    // onClose 监听器经 props 传入（emit → attrs 监听）：计数存闭包，unmount 后仍可读
    let closed = 0
    const w = mount(BotDeck, { props: { store, onClose: () => { closed += 1 } } })
    await w.find('.deck__close').trigger('click')
    expect(closed).toBe(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closed).toBe(2)
    w.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closed).toBe(2)
  })
})

describe('initialRoomId prop（T10 落地房默认，向后兼容）', () => {
  it('传入 initialRoomId 时新建表单房间预填该房；缺省退回首个公共房', () => {
    const runnerStub = makeRunnerStub()
    const store = createBotStore({
      wsUrl: 'ws://test',
      rng: () => 0.5,
      deps: { tabId: 'tab-A', createRunner: runnerStub.factory, sleep: () => Promise.resolve() },
    })
    disposables.push(store)
    const w = mount(BotDeck, { props: { store, initialRoomId: 'amber' } })
    expect(w.find('.deck__room-input').element.value).toBe('amber')
    w.unmount()
    const w2 = mount(BotDeck, { props: { store } })
    expect(w2.find('.deck__room-input').element.value).toBe('setsubun')
    w2.unmount()
  })
})
