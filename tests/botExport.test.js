// Task 13（§8.1.1 配置桥）——浏览器 deck → daemon 手写 ESM 配置文件的导出序列化测试。
//
// R6（禁跨边 import）：本文件绝不 import packages/bot-daemon/**（那边 config.js 含 node:
// 内建，jsdom 里 import 会炸；反向则把 Vue 拖进 Node）。与 daemon Cfg 的形状兼容，由
// 计划「共享 fixture」权威文本在**两侧各自断言**钉死——对面是
// packages/bot-daemon/tests/config.test.js 的 R6 用例，两边从计划逐字抄同一段文本，
// 谁也不得单方面改写。
//
// 覆盖：A1（key 不进导出物）、R6（同形）、R18(1)+R41（与 core 缺省同值不出行、异值出行——
// 修正轮 1 裁定 R41：活体 bot 全部过 core normalizeCfg，「键不存在」是按钮永远造不出的形状，
// 缺席断言必须由真 deck 对象驱动，否则钉的是小说——Task 3 的 {12,6} 同类缺陷）、
// 转义策略（persona 自由文本含反引号/${}/引号/换行/反斜杠）、bot 自造 id 的稳定 slug 补齐。
import { describe, it, expect, afterEach } from 'vitest'
import { buildConfigFile } from '../src/bots/export'
import { createBotStore } from '../src/bots/store'
import { DEFAULT_CHATTINESS, DEFAULT_TEMPERATURE } from 'kuoluosaigai-bot-core'

// —— 计划「共享 fixture」权威文本，逐字抄（不得单方面改写；对面 Task 4 的 R6 用例同源）——
const FIXTURE_TEXT = [
  'export default {',
  "  name: 'lab-vm',",
  "  serverUrl: 'wss://kuoluosaigai.com',",
  "  provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.KUO_LLM_KEY, model: 'deepseek-chat' },",
  "  limits: { globalHourlyMessages: 120, quietHours: { from: '01:30', to: '08:00' } },",
  '  bots: [',
  "    { id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula', chattiness: 70, temperature: 1.1, hourlyBudget: 20 },",
  '  ],',
  '}',
].join('\n')

const BOT_ID_RE = /^[a-z0-9-]{1,32}$/

/**
 * 把 `export default {...}` 文本求值为对象：new Function 解析（R6 钉死的做法，不 import
 * 任何校验器）。`apiKey: process.env.KUO_LLM_KEY` 是标识符引用——jsdom 里 `process`
 * 可能存在也可能不存在（取决于跑测器注入），必须用**形参遮蔽**把它变成确定的注入点。
 */
function evalConfigText(text) {
  const fn = new Function('process', text.replace('export default', 'return'))
  return fn({ env: { KUO_LLM_KEY: 'ENV-SENTINEL' } })
}

describe('A1：apiKey 永不进导出物', () => {
  it('导出的字符串里不含任何 apiKey 明文，含 "process.env.KUO_LLM_KEY"', () => {
    const text = buildConfigFile({
      providers: [{ id: 'provider-0', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-PLAINTEXT-SECRET-9f3a' }],
      bots: [{ id: 'lixiao', name: '小李', persona: '嘴替', roomId: 'nebula', providerId: 'provider-0', model: 'deepseek-chat' }],
    })
    expect(text).toContain('process.env.KUO_LLM_KEY')
    expect(text).not.toContain('sk-PLAINTEXT-SECRET-9f3a')
    // 占位是**活表达式**不是字符串字面量：求值时 env 值流过（与 §8.1 样例语义一致）
    expect(evalConfigText(text).provider.apiKey).toBe('ENV-SENTINEL')
  })
})

describe('R6：与计划权威共享 fixture 同形（两侧各自断言，不 import daemon）', () => {
  it('导出物与计划"共享 fixture"那段同形（用 new Function 解析比对字段集合）', () => {
    const fixture = evalConfigText(FIXTURE_TEXT)
    const text = buildConfigFile({
      providers: [{ id: 'provider-0', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' }],
      bots: [{
        id: 'lixiao', name: '小李', persona: '大三学生，说话短', roomId: 'nebula',
        chattiness: 70, temperature: 1.1, hourlyBudget: 20, providerId: 'provider-0', model: 'deepseek-chat',
      }],
      deviceName: 'lab-vm',
    })
    const got = evalConfigText(text)
    // 字段集合逐层比对：顶层 = fixture 顶层去掉 limits——浏览器 deck 没有全局闸/静默窗旋钮，
    // 导出器**不得编造** limits 值（与 R18(1) 同源：没有真值就别写行）。
    expect(Object.keys(fixture).sort()).toEqual(['bots', 'limits', 'name', 'provider', 'serverUrl'])
    expect(Object.keys(got).sort()).toEqual(['bots', 'name', 'provider', 'serverUrl'])
    expect(Object.keys(got.provider).sort()).toEqual(Object.keys(fixture.provider).sort())
    expect(Object.keys(got.bots[0]).sort()).toEqual(Object.keys(fixture.bots[0]).sort())
    // 形状之外再钉值：去掉 limits 后两侧解析结果**深度相等**（字段拼写/嵌套/缺省 serverUrl 全对上）
    const fixtureRest = { ...fixture }
    delete fixtureRest.limits
    expect(got).toEqual(fixtureRest)
  })
})

describe('provider 选取', () => {
  it('多 provider → 取 bot 实际引用的那个；未引用的 provider 不进导出物', () => {
    const text = buildConfigFile({
      providers: [
        { id: 'provider-0', name: 'P0', baseUrl: 'https://p0.referenced.test', apiKey: 'k0' },
        { id: 'provider-1', name: 'P1', baseUrl: 'https://p1.unreferenced.test', apiKey: 'k1' },
      ],
      bots: [{ id: 'a', name: 'A', persona: 'p', roomId: 'setsubun', providerId: 'provider-0', model: 'm-a' }],
    })
    const got = evalConfigText(text)
    expect(got.provider.baseUrl).toBe('https://p0.referenced.test')
    expect(got.provider.model).toBe('m-a') // model 在浏览器侧挂 bot，daemon Cfg 挂 provider——取首个引用该 provider 的 bot 的 model
    expect(text).not.toContain('p1.unreferenced.test')
    expect(text).not.toContain('k0')
    expect(text).not.toContain('k1')
  })
})

describe('转义策略（引号内不插值、文本可解析）', () => {
  it('persona 含反引号/${} 的文案 → 转义安全，不破坏模板字符串', () => {
    const hostile = '他说：`你好${name}`\n"双引号" 与 \\ 反斜杠，还有 ${process.env.KUO_LLM_KEY} 休想插值'
    const text = buildConfigFile({
      providers: [{ id: 'p', name: 'P', baseUrl: 'https://x.test', apiKey: 'k' }],
      bots: [{ id: 'x', name: 'X', persona: hostile, roomId: 'setsubun', providerId: 'p', model: 'm' }],
    })
    const got = evalConfigText(text)
    expect(got.bots[0].persona).toBe(hostile) // 往返逐字相等：换行/引号/反斜杠/${} 全数安全
    expect(got.bots[0].persona).not.toContain('ENV-SENTINEL') // ${...} 未发生内插
  })
})

describe('id 补齐（daemon 红线 [a-z0-9-]{1,32}）', () => {
  it('bots[].id 缺失（浏览器自造 bot-0）→ 导出时补一个合 [a-z0-9-]{1,32} 的稳定 slug', () => {
    const bots = [{ name: '小李', persona: 'p', roomId: 'nebula' }]
    const text1 = buildConfigFile({ providers: [], bots })
    const text2 = buildConfigFile({ providers: [], bots })
    expect(text1).toBe(text2) // 稳定：同一输入两次导出逐字节相同（Q3：id 增删才是增删）
    expect(evalConfigText(text1).bots[0].id).toMatch(BOT_ID_RE)
  })

  it('合法 id 原样保留；非法/中文名净化或哈希兜底；同输入两 bot 的 slug 互不相同', () => {
    const got = evalConfigText(buildConfigFile({
      providers: [],
      bots: [
        { id: 'bot-0', name: 'A', persona: 'p', roomId: 'nebula' },
        { name: '重复', persona: 'a', roomId: 'nebula' },
        { name: '重复', persona: 'b', roomId: 'nebula' },
        { id: 'BAD ID! 李', name: 'C', persona: 'c', roomId: 'nebula' },
      ],
    }))
    const ids = got.bots.map((b) => b.id)
    expect(ids[0]).toBe('bot-0') // 浏览器自造 id 本就合规 → 不动
    for (const id of ids) expect(id).toMatch(BOT_ID_RE)
    expect(new Set(ids).size).toBe(4)
  })
})

describe('R18(1)+R41：真形状驱动——同 core 缺省值不出行，异值出行', () => {
  // 修正轮 1 裁定 R41：按钮的唯一数据源是 reactive deck，deck 里每个 bot 都过了 core
  // normalizeCfg（deck.js:496/499），chattiness/temperature **永远带值在场**——旧版用
  // 「键不存在」的手造输入做缺席断言，钉的是活体造不出的形状（Task 3 {12,6} 同类缺陷）。
  // 本组改为 createBotStore+addBot 造**按钮同款对象**驱动：同缺省 ⇒ 整行省略（让 daemon
  // 继承 core 缺省，日后改默认继续生效）；异缺省 ⇒ 出行。
  const disposables = []
  afterEach(() => {
    while (disposables.length) disposables.pop().dispose()
  })
  function makeStore() {
    const m = new Map()
    const storage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
    const store = createBotStore({ storage, now: () => 1730000000000, deps: { tabId: 'tab-export-test' } })
    disposables.push(store)
    return store
  }

  it('deck 默认新建 bot（chattiness/temperature 在场且等于 core 缺省）→ 导出文本无 chattiness:/temperature:/hourlyBudget: 行', () => {
    const store = makeStore()
    store.addBot({ name: '小李', persona: 'p', roomId: 'nebula' })
    const bot = store.bots[0]
    // 钉住输入形状：值在场且恰是 core 缺省——本用例绝不允许靠「字段本来就缺」偷绿
    expect(bot.chattiness).toBe(DEFAULT_CHATTINESS)
    expect(bot.temperature).toBe(DEFAULT_TEMPERATURE)
    const text = buildConfigFile({ providers: store.providers, bots: store.bots })
    expect(text).not.toMatch(/chattiness:/)
    expect(text).not.toMatch(/temperature:/)
    expect(text).not.toMatch(/hourlyBudget:/)
    const got = evalConfigText(text)
    expect(got.bots[0]).not.toHaveProperty('chattiness')
    expect(got.bots[0]).not.toHaveProperty('temperature')
    expect(got.bots[0]).not.toHaveProperty('hourlyBudget')
  })

  it('deck bot 与缺省不同（chattiness 70 / temperature 1.1 / hourlyBudget 20）→ 行在场且值正确', () => {
    const store = makeStore()
    store.addBot({ name: '小李', persona: 'p', roomId: 'nebula', chattiness: 70, temperature: 1.1, hourlyBudget: 20 })
    const bot = store.bots[0]
    expect(bot.chattiness).toBe(70) // 输入形状证：真 deck 存了非缺省值
    expect(bot.hourlyBudget).toBe(20)
    const got = evalConfigText(buildConfigFile({ providers: store.providers, bots: store.bots }))
    expect(got.bots[0].chattiness).toBe(70)
    expect(got.bots[0].temperature).toBe(1.1)
    expect(got.bots[0].hourlyBudget).toBe(20)
    expect(typeof DEFAULT_CHATTINESS).toBe('number') // 镜像护栏：若实现「全省略」矫枉过正，本用例先红
  })

  it('显式 0 与 core 缺省不同 → 必须出行（0 是语义值，既不是缺省也不是未设）', () => {
    const text = buildConfigFile({
      providers: [],
      bots: [{ id: 'k', name: 'K', persona: 'p', roomId: 'nebula', chattiness: 0, temperature: 0, hourlyBudget: 0 }],
    })
    expect(text).toContain('chattiness: 0')
    expect(text).toContain('temperature: 0')
    expect(text).toContain('hourlyBudget: 0')
  })

  it('防御面：null/undefined 可选字段与空 rawPrompt 一律不出行', () => {
    const text = buildConfigFile({
      providers: [],
      bots: [{ id: 'k', name: 'K', persona: 'p', roomId: 'nebula', chattiness: null, temperature: undefined, rawPrompt: '' }],
    })
    expect(text).not.toMatch(/chattiness:/)
    expect(text).not.toMatch(/temperature:/)
    expect(text).not.toMatch(/rawPrompt/)
  })
})
