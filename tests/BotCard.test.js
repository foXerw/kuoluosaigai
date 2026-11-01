// Task 9 / spec §8.4 —— BotCard 卡片渲染与操作契约（brief Step 1 五条全落实）。
// 消费真 createBotStore（mock storage + deps.createRunner 注入），不自造 fake store。
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BotCard from '../src/components/BotCard.vue'
import { createBotStore } from '../src/bots/store'
import { RHYTHM_DEFAULTS } from '../src/bots/rhythm'

function makeMemStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    _map: map,
  }
}

// runner 桩：pushFrame 经 onState({rev}) 上报——rt.rev 即观战窗刷新信号（T8 契约）
function makeRunnerStub() {
  const byBot = new Map()
  const factory = (opts) => {
    const r = {
      opts,
      seq: 0,
      buffer: [],
      cleared: 0,
      switches: [],
      start() {},
      stop() { opts.onEvent('stopped', null) },
      switchRoom(roomId) { r.switches.push(roomId); opts.onState({ roomId }) },
      clearBuffer() { r.cleared += 1; r.buffer = []; opts.onState({ rev: ++r.seq }) },
      getBuffer() { return r.buffer },
      pushFrame(f) { r.buffer = [...r.buffer, f]; opts.onState({ rev: ++r.seq }) },
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
afterEach(() => {
  while (disposables.length) disposables.pop().dispose()
})

function setup() {
  const runnerStub = makeRunnerStub()
  const store = createBotStore({
    wsUrl: 'ws://test',
    storage: makeMemStorage(),
    sessionStorage: makeMemStorage(),
    rng: () => 0.5,
    now: () => 0,
    deps: { tabId: 'tab-A', createRunner: runnerStub.factory, sleep: () => Promise.resolve() },
  })
  disposables.push(store)
  return { store, runnerStub }
}

const API_KEY = 'sk-SUPERSECRET-9527' // B9：任何渲染位不得出现

function seed(store, over = {}) {
  store.addProvider({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: API_KEY })
  store.addBot({
    name: '美化',
    persona: '傲娇话痨',
    chattiness: 60,
    providerId: store.providers[0].id,
    model: 'deepseek-chat',
    temperature: 0.7,
    roomId: 'setsubun',
    ...over,
  })
  return store.bots[0]
}

function mountCard(store, bot) {
  return mount(BotCard, { props: { bot, providers: store.providers } })
}

describe('BotCard', () => {
  it('渲染：name/badge 预览(BOT·name)/状态灯 class/roomId/会话 tokens(prompt+completion)/小时余量(30 - hourCount)', async () => {
    const { store } = setup()
    const bot = seed(store)
    bot.rt.session = { promptTokens: 1200, completionTokens: 340, messages: 5 }
    bot.rt.hourCount = 7
    const w = mountCard(store, bot)
    const text = w.text()
    expect(text).toContain('美化')
    expect(text).toContain('BOT·美化') // badge 预览与 runner 口径一致
    expect(w.find('.bot-card__lamp').classes()).toContain('bot-card__lamp--stopped')
    expect(text).toContain('setsubun')
    expect(text).toContain('1200') // prompt tokens
    expect(text).toContain('340') // completion tokens
    expect(text).toContain('5') // 发言数
    expect(text).toContain(String(RHYTHM_DEFAULTS.hourlyCap - 7)) // 小时余量不硬编码
    // 状态灯随 rt.status 变
    bot.rt.status = 'open'
    await w.vm.$nextTick()
    expect(w.find('.bot-card__lamp').classes()).toContain('bot-card__lamp--open')
  })

  it('otherTab=true → 启停按钮 disabled 且显示「在另一标签运行中」', () => {
    const { store } = setup()
    const bot = seed(store)
    bot.rt.otherTab = true
    const w = mountCard(store, bot)
    expect(w.text()).toContain('在另一标签运行中')
    expect(w.find('.bot-card__start').attributes('disabled')).toBeDefined()
    expect(w.find('.bot-card__stop').attributes('disabled')).toBeDefined()
  })

  it('操作：启/停/切房(输入新 roomId 确认)/清空缓冲/update/remove 各 emit 对应事件', async () => {
    const { store } = setup()
    const bot = seed(store)
    const w = mountCard(store, bot)
    await w.find('.bot-card__start').trigger('click')
    expect(w.emitted('start')).toEqual([[]])
    bot.rt.status = 'open' // 停止钮仅运行中可点（otherTab 禁用另有专测）
    await w.vm.$nextTick()
    await w.find('.bot-card__stop').trigger('click')
    expect(w.emitted('stop')).toEqual([[]])
    bot.rt.status = 'stopped'
    await w.vm.$nextTick()
    await w.find('.bot-card__room-input').setValue('nebula')
    await w.find('.bot-card__room-go').trigger('click')
    expect(w.emitted('switch-room')).toEqual([['nebula']])
    // 编辑保存 → update 带 patch
    await w.find('.bot-card__edit-toggle').trigger('click')
    await w.find('.bot-card__name-input').setValue('雏')
    await w.find('.bot-card__save').trigger('click')
    expect(w.emitted('update')).toEqual([[{
      name: '雏',
      persona: '傲娇话痨',
      chattiness: 60,
      providerId: store.providers[0].id,
      model: 'deepseek-chat',
      temperature: 0.7,
    }]])
    await w.find('.bot-card__expand').trigger('click')
    await w.find('.bot-card__clear').trigger('click')
    expect(w.emitted('clear-buffer')).toEqual([[]])
    await w.find('.bot-card__remove').trigger('click')
    expect(w.emitted('remove')).toEqual([[]])
  })

  it('展开 → 观战窗列出 buffer 帧（nick+badge+text），新帧（rev 变化）后更新', async () => {
    const { store, runnerStub } = setup()
    const bot = seed(store)
    await store.startBot(bot.id)
    const r = runnerStub.byBot.get(bot.id)
    r.pushFrame({ id: 'f1', nick: 'ANON-A', text: '早上好' })
    r.pushFrame({ id: 'f2', nick: '美化', badge: 'BOT·美化', text: '机器人问好' })
    const w = mountCard(store, bot)
    await w.find('.bot-card__expand').trigger('click')
    const text = w.text()
    expect(text).toContain('ANON-A')
    expect(text).toContain('早上好')
    expect(text).toContain('BOT·美化')
    expect(text).toContain('机器人问好')
    // rev 变化 → 观战窗刷新
    r.pushFrame({ id: 'f3', nick: 'ANON-B', text: '新来的帧' })
    await w.vm.$nextTick()
    expect(w.text()).toContain('新来的帧')
  })

  it('status=error → 显示 error 文案且不含 apiKey 子串（B9）', () => {
    const { store } = setup()
    const bot = seed(store)
    bot.rt.status = 'error'
    bot.rt.error = 'LLM 鉴权失败（401）· token 已失效'
    const w = mountCard(store, bot)
    expect(w.text()).toContain('LLM 鉴权失败（401）')
    expect(w.text()).not.toContain(API_KEY)
    expect(w.html()).not.toContain(API_KEY)
  })
})
