// @vitest-environment node
// Task 7：diffConfigs 纯函数测试（先于接线测——brief Step 1）。
// 契约：按 id 寻址（Q3），changed = 除 id 外任一字段变，数组顺序变化不算变更；
// bots: [] 是合法的「用户真想全停」，与畸形读盘的区分归 Task 8 的 watcher 侧。
import { describe, expect, it } from 'vitest'

import { diffConfigs, changedBotFields } from '../converge.js'

function bot(id, over) {
  return Object.assign(
    { id, name: '小李' + id, persona: 'p-' + id, room: 'nebula', chattiness: 50, temperature: 0.9 },
    over || {},
  )
}

function cfg(bots, limits, over) {
  const c = { name: 'lab-vm', provider: { baseUrl: 'https://x', apiKey: 'k', model: 'm' }, bots }
  if (limits !== undefined) c.limits = limits
  return Object.assign(c, over || {})
}

describe('diffConfigs（纯 diff，按 id 寻址）', () => {
  it('新增/删除/改名/改 room 各归其类；全部 unchanged 时四个数组皆空', () => {
    const prev = cfg([bot('a'), bot('b'), bot('c')])
    const next = cfg([bot('a'), bot('b', { name: '大锤' }), bot('d')])
    const d = diffConfigs(prev, next)
    expect(d.added).toEqual(['d'])
    expect(d.removed).toEqual(['c'])
    expect(d.changed).toEqual(['b'])
    expect(d.unchanged).toEqual(['a'])
    expect(d.limitsChanged).toBe(false)
    expect(d.serverUrlChanged).toBe(false) // R27：进 diff 的两位缺省不得虚报
    expect(d.providerChanged).toBe(false)
    // 改 room 也归 changed
    const d2 = diffConfigs(cfg([bot('a')]), cfg([bot('a', { room: 'orbit7' })]))
    expect(d2.changed).toEqual(['a'])
    // 全等 → 四个数组皆空、unchanged 收纳全部 id
    const same = cfg([bot('a'), bot('b')])
    const d3 = diffConfigs(same, cfg([bot('a'), bot('b')]))
    expect(d3.added).toEqual([])
    expect(d3.removed).toEqual([])
    expect(d3.changed).toEqual([])
    expect(d3.unchanged).toEqual(['a', 'b'])
  })

  it('数组顺序变化不视为变更（按 id 集合与字段比较，不是位置，Q3）', () => {
    const prev = cfg([bot('a'), bot('b'), bot('c')])
    const next = cfg([bot('c'), bot('b'), bot('a')])
    const d = diffConfigs(prev, next)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
    expect([...d.unchanged].sort()).toEqual(['a', 'b', 'c'])
  })

  it('limits 变化 → limitsChanged:true（不重启 bot，只重算闸）', () => {
    const prev = cfg([bot('a'), bot('b')], { globalHourlyMessages: 100, quietHours: { from: '01:30', to: '08:00' } })
    const next = cfg([bot('a'), bot('b')], { globalHourlyMessages: 50, quietHours: { from: '01:30', to: '08:00' } })
    const d = diffConfigs(prev, next)
    expect(d.limitsChanged).toBe(true)
    // bot 一律不进动作桶：added/removed/changed 全空，unchanged 收纳全部
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
    expect(d.unchanged).toEqual(['a', 'b'])
  })

  it('limits 未配置↔配置、键序不同都判得准（纯数据深比较，不看写入顺序）', () => {
    const bots = [bot('a')]
    expect(diffConfigs(cfg(bots), cfg(bots)).limitsChanged).toBe(false)
    expect(diffConfigs(cfg(bots), cfg(bots, { startupQuietMs: 1000 })).limitsChanged).toBe(true)
    expect(diffConfigs(cfg(bots, { startupQuietMs: 1000 }), cfg(bots)).limitsChanged).toBe(true)
    const l1 = { globalHourlyMessages: 10, quietHours: { to: '08:00', from: '01:30' } }
    const l2 = { quietHours: { from: '01:30', to: '08:00' }, globalHourlyMessages: 10 }
    expect(diffConfigs(cfg(bots, l1), cfg(bots, l2)).limitsChanged).toBe(false)
  })

  it('bots: [] vs 三个 bot → removed 三项（用户真想全停，与畸形读盘的区别由 watcher 侧负责，Task 8）', () => {
    const d = diffConfigs(cfg([bot('a'), bot('b'), bot('c')]), cfg([]))
    expect([...d.removed].sort()).toEqual(['a', 'b', 'c'])
    expect(d.added).toEqual([])
    expect(d.changed).toEqual([])
    expect(d.unchanged).toEqual([])
    // 反方向：空配置起步 → 三项 added
    const r = diffConfigs(cfg([]), cfg([bot('a'), bot('b'), bot('c')]))
    expect([...r.added].sort()).toEqual(['a', 'b', 'c'])
    expect(r.removed).toEqual([])
  })

  it('hourlyBudget/rawPrompt 的「未配↔配置」也是字段变更（R24 语义：缺省≠0，不可混写）', () => {
    expect(diffConfigs(cfg([bot('a')]), cfg([bot('a', { hourlyBudget: 20 })])).changed).toEqual(['a'])
    expect(diffConfigs(cfg([bot('a', { hourlyBudget: 20 })]), cfg([bot('a')])).changed).toEqual(['a'])
    expect(diffConfigs(cfg([bot('a', { rawPrompt: 'x' })]), cfg([bot('a', { rawPrompt: 'x' })])).changed).toEqual([])
    expect(diffConfigs(cfg([bot('a', { hourlyBudget: 0 })]), cfg([bot('a', { hourlyBudget: 0 })])).unchanged).toEqual(['a'])
  })

  it('R27①：serverUrl 变化 → serverUrlChanged:true（与 limits 同类：要的是进程重启）；不串 bot 桶', () => {
    const bots = [bot('a'), bot('b')]
    const d = diffConfigs(cfg(bots, { startupQuietMs: 100 }), cfg(bots, { startupQuietMs: 100 }, { serverUrl: 'wss://other.example' }))
    expect(d.serverUrlChanged).toBe(true)
    expect(d.limitsChanged).toBe(false)
    expect(d.providerChanged).toBe(false)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
    expect(d.unchanged).toEqual(['a', 'b'])
    // 未配置 serverUrl ↔ 有值也算变更；两边都缺 → 不算
    expect(diffConfigs(cfg(bots), cfg(bots)).serverUrlChanged).toBe(false)
    expect(diffConfigs({ bots }, cfg(bots, undefined, { serverUrl: 'wss://x.dev' })).serverUrlChanged).toBe(true)
  })

  it('R27②：provider 任一字段变化 → providerChanged:true（键序无关）；model 单变也要出声（扇出前提）', () => {
    const bots = [bot('a')]
    const p2 = { apiKey: 'k', model: 'm2', baseUrl: 'https://x' }
    expect(diffConfigs(cfg(bots), cfg(bots, undefined, { provider: p2 })).providerChanged).toBe(true)
    const pSame = { model: 'm', baseUrl: 'https://x', apiKey: 'k' }
    expect(diffConfigs(cfg(bots), cfg(bots, undefined, { provider: pSame })).providerChanged).toBe(false)
    const d3 = diffConfigs(cfg(bots), cfg(bots, undefined, { provider: p2, serverUrl: 'ws://localhost:8080' }))
    expect(d3.providerChanged).toBe(true)
    expect(d3.serverUrlChanged).toBe(true)
    expect(d3.unchanged).toEqual(['a'])
  })

  it('changedBotFields 列出且仅列出实际变化的键（undefined=取消配置的语义保留在补丁里）', () => {
    const prev = bot('a', { hourlyBudget: 20, rawPrompt: 'p' })
    const next = bot('a', { name: '大锤', rawPrompt: 'p' }) // rawPrompt 两边相同 → 不入选
    expect([...changedBotFields(prev, next)].sort()).toEqual(['hourlyBudget', 'name'])
    expect(changedBotFields(prev, prev)).toEqual([])
    // room 变化只报 'room'，由宿主翻成 roomId / switchBotRoom
    expect(changedBotFields(bot('a'), bot('a', { room: 'orbit7' }))).toEqual(['room'])
  })
})
