// @vitest-environment node
// Task 7：daemon 宿主组装测试。注入假 runner（deps.createRunner 走替身，真 WS 不连）、
// 假 logger（只记账）、temp-dir 态存储（绝不写进仓库树）。brief Step 1 的六条用例名
// 逐字保留；其余钉接线面：schedule「配了才传」、R19 两条日志、R20 有效房、R24 透传、
// 孤儿两段账目相加（不是二选一）、A1 key 流向、sink 免疫（Task 1 遗留）。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { SCHEMA_VERSION } from 'kuoluosaigai-bot-core'
import { createFileStateStore } from '../state.js'
import { validateConfig } from '../config.js'
import { createDaemonHost, PROVIDER_ID } from '../host.js'

const SECRET = 'sk-SUPERSECRET-do-not-leak-9f3a'
const SECRET2 = 'sk-ROTATED-secret-value-77ab'

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-host-test-'))
})
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const startedHosts = []
afterEach(() => {
  while (startedHosts.length) {
    const h = startedHosts.pop()
    try {
      h.shutdown() // 清 deck 的 heartbeat/lifetime 定时器：node 环境不留活句柄
    } catch (e) {
      /* noop */
    }
  }
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

// —— 配置 fixture：一律过 validateConfig（cfg 形状的唯一权威），不手搓 ——
function makeRaw(over) {
  return Object.assign(
    {
      name: 'lab-vm',
      serverUrl: 'wss://kuoluosaigai.com',
      provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' },
      bots: [
        { id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula', chattiness: 70, temperature: 1.1, hourlyBudget: 20 },
        { id: 'aqin', name: '阿钦', persona: '沉默寡言', room: 'orbit7' },
      ],
    },
    over || {},
  )
}

function validCfg(over) {
  const res = validateConfig(makeRaw(over))
  if (!res.ok) throw new Error('测试 fixture 非法: ' + res.errors.join('; '))
  return res.cfg
}

function fakeLogger() {
  const rec = { info: [], warn: [], error: [] }
  return {
    rec,
    hasWarn(needle) {
      return rec.warn.some((e) => String(e.msg).includes(needle))
    },
    hasWarnAbout(needle, id) {
      return rec.warn.some((e) => String(e.msg).includes(needle) && String(e.msg).includes(id))
    },
    info: (msg, fields) => rec.info.push({ msg, fields }),
    warn: (msg, fields) => rec.warn.push({ msg, fields }),
    error: (msg, fields) => rec.error.push({ msg, fields }),
  }
}

function spyRunner(o) {
  const r = {
    o,
    started: 0,
    stopped: 0,
    cleared: 0,
    rooms: [],
    start() {
      r.started++
    },
    stop() {
      r.stopped++
    },
    switchRoom(roomId) {
      r.rooms.push(roomId)
    },
    clearBuffer() {
      r.cleared++
    },
    getBuffer() {
      return []
    },
    idleEligible() {
      return false
    },
    idleRoll() {
      return false
    },
    pokeIdle() {},
  }
  return r
}

// 写间谍：包一层 storage 端口，记录 deck 交给 setItem 的**原始载荷**（净化前形状——
// bots 条目带 model 等 BOT_CFG_KEYS）。R27 的 model 扇出与 persist-先于-stop 只在这层可观测。
function setup(cfg, extra) {
  const x = extra || {}
  const dir = x.dir || freshDir()
  const inner = x.store || createFileStateStore({ dir })
  const writes = []
  const store = {
    getItem: (k) => inner.getItem(k),
    setItem: (k, v) => {
      writes.push(v)
      return inner.setItem(k, v)
    },
    removeItem: (k) => inner.removeItem(k),
    readOrphans: () => inner.readOrphans(),
    path: inner.path,
  }
  const log = x.logger || fakeLogger()
  // 固定假钟：boot 期所有 persist 的 lastPersistAt 同刻，10s 节流窗天然处于"未冲刷"态
  // （审查轮 2 #3：原 advance 推移缝已删——其最后一个调用点在 R27 捆绑①改造后消失，
  // trailing 迟到落盘的时序改由 vi fake timers 精确驱动）
  const now = x.now || (() => 1730000000000)
  const WebSocketImpl =
    x.WebSocketImpl ||
    function NoRealWS() {
      throw new Error('测试里禁止构造真 WS')
    }
  const sleep = x.sleep || function testSleep() { return Promise.resolve() }
  const calls = { opts: [], runners: {} }
  const createRunner =
    x.createRunner === null
      ? undefined // 显式要真 runner（本套件不用；留口防止哪天要测真链路）
      : (o) => {
          calls.opts.push(o)
          const r = spyRunner(o)
          calls.runners[o.bot.id] = r
          return r
        }
  const host = createDaemonHost({
    cfg, store, logger: log, now, WebSocketImpl, sleep, createRunner,
    enableLink: false, // P3b 之前的主机单测不接设备 WS；P3b 用专门的假 link 用例
  })
  startedHosts.push(host)
  return { host, store, dir, log, calls, WebSocketImpl, sleep, writes }
}

function parsedWrites(writes) {
  return writes.map((w) => JSON.parse(w))
}

function optsOf(calls, id) {
  const list = calls.opts.filter((o) => o.bot.id === id)
  return list[list.length - 1]
}

function readRawDoc(store) {
  return JSON.parse(fs.readFileSync(store.path, 'utf8'))
}

describe('boot：构造与启动一体化（Task 2 遗留 finding 的落点）', () => {
  it('boot 后 deck.bots 的 id 集合 === cfg.bots 的 id 集合（显式 id，不是 bot-0 自造号）', async () => {
    const { host } = setup(validCfg())
    await host.boot()
    const ids = host.snapshot().bots.map((b) => b.id)
    expect([...ids].sort()).toEqual(['aqin', 'lixiao'])
    expect(ids).not.toContain('bot-0')
    expect(ids).not.toContain('bot-1')
  })

  it('deck 在 boot() 内构造、startBot 同一动作序列内完成：startupQuietMs 的刚上线窗覆盖冷启动', async () => {
    const { host, calls } = setup(validCfg({ limits: { startupQuietMs: 3600000 } }))
    await host.boot()
    const gate = optsOf(calls, 'lixiao').gate
    expect(gate).toBeTruthy() // schedule 传进来了，gate 建出来了
    expect(gate.allowSpeak(false)).toBe(false) // 构造时刻即 startedAt：boot 完成仍在刚上线窗内
    expect(gate.allowSpeak(true)).toBe(true) // 合流语义：点名可回（Q9）
  })

  it('limits 未配置 → schedule 根本不传：runner opts 连 gate 键都不出现、globalHourCount=null（缺省零变化在 daemon 侧成立）', async () => {
    const { host, calls } = setup(validCfg())
    await host.boot()
    const o = optsOf(calls, 'lixiao')
    expect('gate' in o).toBe(false)
    expect(host.snapshot().meta.globalHourCount).toBe(null)
  })

  it('limits 配置了 → schedule 真传：gate 在场、globalHourCount=0（装了闸≠没装，与 null 可区分）', async () => {
    const { host, calls } = setup(validCfg({ limits: { globalHourlyMessages: 120, quietHours: { from: '01:30', to: '08:00' } } }))
    await host.boot()
    expect('gate' in optsOf(calls, 'lixiao')).toBe(true)
    expect(host.snapshot().meta.globalHourCount).toBe(0)
  })

  it('ownerNick 生效：getOwnerNick() 返回配置里的 ANON 昵称（Q11）；未配置返回 null', async () => {
    const a = setup(validCfg({ ownerNick: 'ANON-1234' }))
    await a.host.boot()
    expect(optsOf(a.calls, 'lixiao').getOwnerNick()).toBe('ANON-1234')
    const b = setup(validCfg())
    await b.host.boot()
    expect(optsOf(b.calls, 'lixiao').getOwnerNick()).toBe(null)
  })

  it('wsUrl/WebSocketImpl/sleep 原样接线到 runner；真 WS 构造即抛（没被碰到）', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const o = optsOf(ctx.calls, 'lixiao')
    expect(o.wsUrl).toBe('wss://kuoluosaigai.com')
    expect(o.WebSocketImpl).toBe(ctx.WebSocketImpl)
    expect(o.sleep).toBe(ctx.sleep)
    for (const r of Object.values(ctx.calls.runners)) expect(r.started).toBe(1)
  })

  it('A1 接线：apiKey 只在 provider 构造处进 deck——runner 拿得到，快照与落盘文本没有', async () => {
    const { host, calls, store } = setup(validCfg())
    await host.boot()
    const o = optsOf(calls, 'lixiao')
    expect(o.provider.id).toBe(PROVIDER_ID)
    expect(o.provider.apiKey).toBe(SECRET) // 运行器确实拿到了 key（否则 LLM 路径是死的）
    const raw = fs.readFileSync(store.path, 'utf8')
    expect(raw).not.toContain(SECRET) // Task 5 的剥离照常成立
    expect(JSON.stringify(host.snapshot())).not.toContain(SECRET)
  })

  it('provider.apiKey 为空时兜底读 process.env.KUO_LLM_KEY（finally 还原 env）', async () => {
    const prev = process.env.KUO_LLM_KEY
    process.env.KUO_LLM_KEY = 'env-secret-key'
    try {
      // 手搓未校验 cfg（validateConfig 会拒空 apiKey，这条测的正是宿主自己的兜底分支）
      const raw = makeRaw()
      raw.provider = { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' }
      const ctx = setup(raw)
      await ctx.host.boot()
      expect(optsOf(ctx.calls, 'lixiao').provider.apiKey).toBe('env-secret-key')
    } finally {
      if (prev === undefined) delete process.env.KUO_LLM_KEY
      else process.env.KUO_LLM_KEY = prev
    }
  })

  it('R24 透传：cfg.bots[].hourlyBudget 进 runner 快照；未配的 bot 不带该键（缺省≠0）', async () => {
    const { host, calls } = setup(validCfg())
    await host.boot()
    expect(optsOf(calls, 'lixiao').bot.hourlyBudget).toBe(20)
    // 未配的 bot：deck 的 pick 把缺键洗成 null（R17：null 不触发参数缺省、Number.isFinite
    // 判假 =「未配」）——关键断言是 null 而非 0，0 会被 runner 当「点名外一条不发」。
    expect(optsOf(calls, 'aqin').bot.hourlyBudget).toBe(null)
  })

  it('孤儿复用：state 里 orphans["lixiao"].nick="ANON-7C2D"，配置重新出现同 id → 复用该 nick', async () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    fs.writeFileSync(
      store.path,
      JSON.stringify({
        version: SCHEMA_VERSION,
        providers: [],
        bots: [],
        lifetime: {},
        orphans: { lixiao: { nick: 'ANON-7C2D', lifetime: { promptTokens: 10, completionTokens: 5 } } },
      }),
    )
    const ctx = setup(validCfg(), { store, dir })
    await ctx.host.boot()
    const lixiao = ctx.host.snapshot().bots.find((b) => b.id === 'lixiao')
    expect(lixiao.nick).toBe('ANON-7C2D')
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'aqin').nick).toBe(null)
    // R19①：boot 复用孤儿身份必须打 info（含 id 与复用的 nick）
    expect(ctx.log.rec.info.some((e) => e.msg.includes('lixiao') && e.msg.includes('ANON-7C2D'))).toBe(true)
  })

  it('孤儿账目相加：旧段(orphan 10/5)+新段(复用后 3/4)=13/9——两段不相交，必须求和不是二选一', async () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    fs.writeFileSync(
      store.path,
      JSON.stringify({
        version: SCHEMA_VERSION,
        providers: [],
        bots: [],
        lifetime: {},
        orphans: { lixiao: { nick: 'ANON-7C2D', lifetime: { promptTokens: 10, completionTokens: 5 } } },
      }),
    )
    const ctx = setup(validCfg(), { store, dir })
    await ctx.host.boot()
    // 复用前：快照的 lifetime = 孤儿旧段
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'lixiao').lifetime).toEqual({ promptTokens: 10, completionTokens: 5 })
    optsOf(ctx.calls, 'lixiao').onState({ session: { promptTokens: 3, completionTokens: 4, messages: 1 } })
    // 复用后新段进 deck.lifetime，旧段仍在 orphans——快照相加
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'lixiao').lifetime).toEqual({ promptTokens: 13, completionTokens: 9 })
  })

  it('boot 清场：盘里有 ghost（配置已删）→ 移出 deck、ORPHAN warn、身份进 orphans', async () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    fs.writeFileSync(
      store.path,
      JSON.stringify({
        version: SCHEMA_VERSION,
        providers: [],
        bots: [{ id: 'ghost', nick: 'ANON-GH0' }],
        lifetime: { ghost: { promptTokens: 2, completionTokens: 1 } },
        orphans: {},
      }),
    )
    const ctx = setup(validCfg(), { store, dir })
    await ctx.host.boot()
    expect(ctx.host.snapshot().bots.map((b) => b.id).sort()).toEqual(['aqin', 'lixiao'])
    expect(ctx.log.hasWarn('ORPHAN')).toBe(true)
    expect(ctx.log.hasWarnAbout('ORPHAN', 'ghost')).toBe(true)
    expect(store.readOrphans().ghost).toEqual({ nick: 'ANON-GH0', lifetime: { promptTokens: 2, completionTokens: 1 } })
  })

  it('重启不重影：同一 store 二次 boot（新 host）不重复 addBot，id 集合与数量不变', async () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    const cfg = validCfg()
    const first = setup(cfg, { store, dir })
    await first.host.boot()
    first.host.shutdown()
    const second = setup(cfg, { store, dir })
    await second.host.boot()
    const ids = second.host.snapshot().bots.map((b) => b.id)
    expect([...ids].sort()).toEqual(['aqin', 'lixiao'])
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('未 boot 的 snapshot：bots 空、globalHourCount=null、uptimeMs=0（status 面在任何时刻可读）', () => {
    const { host } = setup(validCfg())
    const s = host.snapshot()
    expect(s.bots).toEqual([])
    expect(s.meta.globalHourCount).toBe(null)
    expect(s.meta.uptimeMs).toBe(0)
    expect(s.meta.name).toBe('lab-vm')
  })
})

describe('converge：热重载调和（A4：不变的 bot 不掉线）', () => {
  it('converge 删除 bot：deck 里移除、runner.stop 被调、state 里进 orphans（不误删身份，Q2）', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    optsOf(ctx.calls, 'aqin').onEvent('nick', { nick: 'ANON-Z9X' })
    optsOf(ctx.calls, 'aqin').onState({ session: { promptTokens: 2, completionTokens: 1, messages: 1 } })
    // 故意不推时钟：这笔账落在 deck 的 10s 节流窗**之内**、还没自己落盘——
    // R27 捆绑①要求宿主在删除前显式 deck.persist()，孤儿折叠才拿得到它。
    const bs = makeRaw().bots
    const report = await ctx.host.converge(validCfg({ bots: [bs[0]] }))
    expect(report.removed).toEqual(['aqin'])
    expect(ctx.host.snapshot().bots.map((b) => b.id)).toEqual(['lixiao'])
    // 删除先停：runner.stop 确实被调（deck.removeBot 对遗留实例还会幂等再停一次）
    expect(ctx.calls.runners.aqin.stopped).toBeGreaterThanOrEqual(1)
    expect(ctx.store.readOrphans().aqin).toEqual({ nick: 'ANON-Z9X', lifetime: { promptTokens: 2, completionTokens: 1 } })
    // persist 先于 stop/remove 的写序钉法：最后一次带 aqin 的落盘载荷必须已含它的账
    const docs = parsedWrites(ctx.writes)
    expect(docs[docs.length - 1].bots.some((b) => b.id === 'aqin')).toBe(false)
    const lastWithAqin = docs.slice(0, -1).reverse().find((d) => d.bots.some((b) => b.id === 'aqin'))
    expect(lastWithAqin.lifetime.aqin).toEqual({ promptTokens: 2, completionTokens: 1 })
    // R19②：warn 级 ORPHAN，点名 id 且告知身份与账目保留在 state
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('ORPHAN') && e.msg.includes('aqin'))).toBe(true)
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('ORPHAN') && e.msg.includes('state'))).toBe(true)
  })

  it('converge 改名（name 变、id 不变）→ 走 updateBot，**不** stop/start（A4：不许掉线）', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const bs = makeRaw().bots
    const next = validCfg({ bots: [Object.assign({}, bs[0], { name: '李大锤' }), bs[1]] })
    const report = await ctx.host.converge(next)
    expect(report.changed).toEqual(['lixiao'])
    expect(report.unchanged).toEqual(['aqin'])
    expect(ctx.calls.runners.lixiao.started).toBe(1) // 仍只有 boot 那一次
    expect(ctx.calls.runners.lixiao.stopped).toBe(0)
    expect(ctx.calls.opts.filter((o) => o.bot.id === 'lixiao').length).toBe(1) // 没有重新 add/重建 runner
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'lixiao').name).toBe('李大锤')
  })

  it('converge 改 room → switchBotRoom 活切（runner.switchRoom），不断线；快照报新配置房', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const bs = makeRaw().bots
    const next = validCfg({ bots: [Object.assign({}, bs[0], { room: 'cratr1' }), bs[1]] })
    const report = await ctx.host.converge(next)
    expect(report.changed).toEqual(['lixiao'])
    expect(ctx.calls.runners.lixiao.rooms).toEqual(['cratr1'])
    expect(ctx.calls.runners.lixiao.stopped).toBe(0)
    expect(ctx.calls.runners.lixiao.started).toBe(1)
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'lixiao').room).toBe('cratr1')
  })

  it('converge 新增 bot：addBot(显式 id)+startBot；孤儿在场则复用 nick 并打 info', async () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    fs.writeFileSync(
      store.path,
      JSON.stringify({
        version: SCHEMA_VERSION,
        providers: [],
        bots: [],
        lifetime: {},
        orphans: { wangmazi: { nick: 'ANON-WM01', lifetime: null } },
      }),
    )
    const ctx = setup(validCfg(), { store, dir })
    await ctx.host.boot()
    const bs = makeRaw().bots
    const next = validCfg({ bots: [bs[0], bs[1], { id: 'wangmazi', name: '王麻子', persona: '话痨', room: 'dust01' }] })
    const report = await ctx.host.converge(next)
    expect(report.added).toEqual(['wangmazi'])
    expect(ctx.calls.runners.wangmazi.started).toBe(1)
    expect(ctx.host.snapshot().bots.find((b) => b.id === 'wangmazi').nick).toBe('ANON-WM01')
    expect(ctx.log.rec.info.some((e) => e.msg.includes('wangmazi') && e.msg.includes('ANON-WM01'))).toBe(true)
  })

  it('converge limits 变化 → report.limitsChanged、不动任何 bot 连接、warn 告知重启后生效', async () => {
    const ctx = setup(validCfg({ limits: { globalHourlyMessages: 100 } }))
    await ctx.host.boot()
    const next = validCfg({ limits: { globalHourlyMessages: 50 } })
    const report = await ctx.host.converge(next)
    expect(report.limitsChanged).toBe(true)
    expect(report.added).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.changed).toEqual([])
    expect(report.unchanged).toEqual(['lixiao', 'aqin'])
    for (const r of Object.values(ctx.calls.runners)) {
      expect(r.started).toBe(1) // A4：limits 变更不掉线
      expect(r.stopped).toBe(0)
    }
    expect(report.restartRequired).toBe(true)
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('limits') && e.msg.includes('重启'))).toBe(true)
  })

  it('R27①：converge 换 serverUrl → serverUrlChanged 如实上报、warn 告知需重启、bot 连接一律不动', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const report = await ctx.host.converge(validCfg({ serverUrl: 'ws://localhost:8080' }))
    expect(report.serverUrlChanged).toBe(true)
    expect(report.limitsChanged).toBe(false)
    expect(report.added).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.changed).toEqual([])
    expect(report.restartRequired).toBe(true) // 与 limits 同类：进程重启，不是 bot 重启
    for (const r of Object.values(ctx.calls.runners)) {
      expect(r.started).toBe(1)
      expect(r.stopped).toBe(0)
    }
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('serverUrl') && e.msg.includes('重启'))).toBe(true)
  })

  it('R27 捆绑②（R26 完成条件）：pending 重启是粘滞的 meta 位——后续无变化的 converge 不洗掉，只由进程重启（新 host）清除', async () => {
    const ctx = setup(validCfg({ limits: { globalHourlyMessages: 100 } }))
    await ctx.host.boot()
    expect(ctx.host.snapshot().meta.restartRequired).toBe(false)
    await ctx.host.converge(validCfg({ limits: { globalHourlyMessages: 50 } }))
    expect(ctx.host.snapshot().meta.restartRequired).toBe(true)
    // 再来一次纯无变化的 converge：粘滞位不许被抹
    const noop = await ctx.host.converge(validCfg({ limits: { globalHourlyMessages: 50 } }))
    expect(noop.limitsChanged).toBe(false)
    expect(noop.restartRequired).toBe(false)
    expect(ctx.host.snapshot().meta.restartRequired).toBe(true)
    // 新 host = 进程重启语义：复位为 false
    const fresh = setup(validCfg({ limits: { globalHourlyMessages: 50 } }))
    expect(fresh.host.snapshot().meta.restartRequired).toBe(false)
  })

  it('converge provider 变化 → deck provider 即时更新（盘上 baseUrl 变、key 永不落盘），report 如实标注生效时机', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const next = validCfg({ provider: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: SECRET2, model: 'kimi-k2' } })
    const report = await ctx.host.converge(next)
    expect(report.providerChanged).toBe(true)
    expect(report.needsBotRestart).toBe(true)
    const doc = readRawDoc(ctx.store)
    expect(doc.providers[0].id).toBe(PROVIDER_ID)
    expect(doc.providers[0].baseUrl).toBe('https://api.moonshot.cn/v1')
    const raw = fs.readFileSync(ctx.store.path, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(SECRET2) // 新 key 同样被 Task 5 剥离
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('provider') && e.msg.includes('生效'))).toBe(true)
    expect(JSON.stringify(ctx.host.snapshot())).not.toContain(SECRET2)
    // R27②：model 扇出到**全部存活 bot**（含未变更的 aqin）——deck 写载荷（净化前）可观测
    const docs = parsedWrites(ctx.writes)
    const last = docs[docs.length - 1]
    expect(last.bots.map((b) => [b.id, b.model]).sort()).toEqual([['aqin', 'kimi-k2'], ['lixiao', 'kimi-k2']])
    // 且走的是 updateBot：不 stop/start、不切房、不清缓冲、不新造 runner（A4）
    for (const r of Object.values(ctx.calls.runners)) {
      expect(r.started).toBe(1)
      expect(r.stopped).toBe(0)
      expect(r.rooms.length).toBe(0)
      expect(r.cleared).toBe(0)
    }
    expect(ctx.calls.opts.length).toBe(2) // 仍只有 boot 期两个 runner 快照
  })

  it('审查#1 回归：未校验直连路径把 model 改成空串时，扇出值守卫兜住——存活 bot 的 model 不许变 undefined', async () => {
    // config.js:179-180 经 validateConfig 不可能给出空 model；这条钉的是**绕过校验直连**
    // 宿主的文档化路径。deck.updateBot 对 'model' in patch 就写（deck.js:276-281），
    // 无守卫则 undefined 毒死**全部**存活 bot 的下次启动（runner.js:413 配置缺失：model）。
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const next = validCfg()
    next.provider = Object.assign({}, next.provider, { model: '' })
    const report = await ctx.host.converge(next)
    expect(report.providerChanged).toBe(true)
    expect(ctx.log.rec.warn.some((e) => e.msg.includes('已扇出'))).toBe(false) // 没扇出就不许宣称扇出
    const docs = parsedWrites(ctx.writes)
    const last = docs[docs.length - 1]
    expect(last.bots.map((b) => [b.id, b.model]).sort()).toEqual([
      ['aqin', 'deepseek-chat'],
      ['lixiao', 'deepseek-chat'],
    ])
  })

  it('审查#2：combined converge（limits 与 provider 同时变）→ 两条 warn 各说各话，provider 线不被 else-if 吞', async () => {
    const ctx = setup(validCfg({ limits: { globalHourlyMessages: 100 } }))
    await ctx.host.boot()
    const next = validCfg({
      limits: { globalHourlyMessages: 50 },
      provider: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: SECRET2, model: 'kimi-k2' },
    })
    const report = await ctx.host.converge(next)
    expect(report.limitsChanged).toBe(true)
    expect(report.providerChanged).toBe(true)
    expect(report.restartRequired).toBe(true)
    expect(ctx.log.rec.warn.filter((e) => e.msg.includes('limits')).length).toBe(1)
    expect(ctx.log.rec.warn.filter((e) => e.msg.includes('provider 配置变化')).length).toBe(1)
    expect(ctx.host.snapshot().meta.restartRequired).toBe(true)
    // 扇出照常（model 非空合法值）：净化前载荷两端都是 kimi-k2
    const docs = parsedWrites(ctx.writes)
    expect(docs[docs.length - 1].bots.map((b) => [b.id, b.model]).sort()).toEqual([
      ['aqin', 'kimi-k2'],
      ['lixiao', 'kimi-k2'],
    ])
  })

  it('审查#3：删除后 trailing 节流 persist 迟到落盘 → 孤儿账目不二次折叠（精确保持 2/1，不是二选一也不是翻倍）', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    optsOf(ctx.calls, 'aqin').onEvent('nick', { nick: 'ANON-Z9X' })
    vi.useFakeTimers()
    try {
      // 时钟不动 → 这笔账停在 10s 节流窗内的 trailing timer 上
      optsOf(ctx.calls, 'aqin').onState({ session: { promptTokens: 2, completionTokens: 1, messages: 1 } })
      const bs = makeRaw().bots
      await ctx.host.converge(validCfg({ bots: [bs[0]] })) // 宿主 persist 先冲刷 → 删除 → 已折叠一次
      expect(ctx.store.readOrphans().aqin).toEqual({ nick: 'ANON-Z9X', lifetime: { promptTokens: 2, completionTokens: 1 } })
      const writesBefore = ctx.writes.length
      vi.advanceTimersByTime(10000) // trailing persist 迟到触发
      expect(ctx.writes.length).toBeGreaterThan(writesBefore) // 确实又写了一次
      // 二次折叠会把它记成 4/2 或复活 aqin 的消失事件——两头都必须纹丝不动
      expect(ctx.store.readOrphans().aqin).toEqual({ nick: 'ANON-Z9X', lifetime: { promptTokens: 2, completionTokens: 1 } })
      expect(readRawDoc(ctx.store).orphans.aqin).toEqual({ nick: 'ANON-Z9X', lifetime: { promptTokens: 2, completionTokens: 1 } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('converge 后 ownerNick 读取即取新值（getOwnerNick 是活引用，不是 boot 快照）', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    await ctx.host.converge(validCfg({ ownerNick: 'ANON-OWNER2' }))
    expect(optsOf(ctx.calls, 'lixiao').getOwnerNick()).toBe('ANON-OWNER2')
  })
})

describe('snapshot 与观测汇（Task 1 的端口在此接线）', () => {
  it('R30/P3：boot 前 deviceId null；boot 后由本地设备令牌派生（不是主机名）', async () => {
    const ctx = setup(validCfg())
    const before = ctx.host.snapshot()
    expect('deviceId' in before.meta).toBe(true)
    expect(before.meta.deviceId).toBe(null)
    await ctx.host.boot()
    const after = ctx.host.snapshot()
    expect('deviceId' in after.meta).toBe(true)
    expect(after.meta.deviceId).toMatch(/^[a-f0-9]{16}$/)
    const doc = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'device.json'), 'utf8'))
    expect(after.meta.deviceId).toBe(
      crypto.createHash('sha256').update(doc.token).digest('hex').slice(0, 16),
    )
    expect(after.meta.deviceId).not.toContain(os.hostname())
  })

  it('snapshot 不含 apiKey 任何子串', async () => {
    const ctx = setup(validCfg())
    await ctx.host.boot()
    const bs = makeRaw().bots
    await ctx.host.converge(validCfg({ bots: [Object.assign({}, bs[0], { name: '大锤' })] }))
    const s = JSON.stringify(ctx.host.snapshot())
    expect(s).not.toContain(SECRET)
    expect(s).not.toContain(SECRET.slice(0, 10))
    expect(s).not.toContain(SECRET.slice(-10))
    expect(s).not.toContain('apiKey')
    // 形状钉住（Task 10/P3 消费面）：每 bot 八字段 + meta 八键（P3b 增 paired/linkStatus）
    const lixiao = ctx.host.snapshot().bots.find((b) => b.id === 'lixiao')
    expect(Object.keys(lixiao).sort()).toEqual(['hourCount', 'id', 'lifetime', 'name', 'nick', 'room', 'session', 'status'])
    expect(lixiao.session).toEqual({ promptTokens: 0, completionTokens: 0, messages: 0 })
    expect(['deviceId', 'name', 'uptimeMs', 'globalHourCount', 'generatedAt', 'restartRequired', 'paired', 'linkStatus']).toEqual(
      expect.arrayContaining(Object.keys(ctx.host.snapshot().meta)),
    )
    expect(ctx.host.snapshot().meta.restartRequired).toBe(false)
  })

  it('Q7 转发：runner error/warn → logger.error/warn 且载荷带 botId；deck 级 warn 无 botId 键可区分', async () => {
    // 手搓带坏 quietHours 端点的 cfg（validateConfig 会拒——这条测的是宿主**不消毒**、
    // deck 构造期 announce（审查轮 1 #1：无 botId 键）照原样上汇的透传）
    const cfg = validCfg()
    cfg.limits = { quietHours: { from: '25:00', to: '08:00' } }
    const ctx = setup(cfg)
    await ctx.host.boot()
    expect(ctx.log.rec.warn.some((e) => e.fields && !('botId' in e.fields) && String(e.fields.reason).includes('quietHours'))).toBe(true)
    optsOf(ctx.calls, 'lixiao').onEvent('error', { kind: 'rate', message: 'LLM 调用失败: rate（HTTP 429）', fatal: false })
    const errEntry = ctx.log.rec.error[ctx.log.rec.error.length - 1]
    expect(errEntry).toBeTruthy()
    expect(errEntry.fields.botId).toBe('lixiao')
    expect(errEntry.fields.kind).toBe('rate')
    optsOf(ctx.calls, 'aqin').onEvent('warn', { reason: 'SLOW DOWN' })
    const warnEntry = ctx.log.rec.warn[ctx.log.rec.warn.length - 1]
    expect(warnEntry.fields.botId).toBe('aqin')
    expect(warnEntry.fields.reason).toBe('SLOW DOWN')
  })

  it('sink 免疫：logger 抛错绝不逃逸（Task 1 遗留——sink 在 runner catch 内被调，24/7 进程不容 unhandled rejection）', async () => {
    const boom = () => {
      throw new Error('disk full')
    }
    const logger = { info: boom, warn: boom, error: boom }
    const ctx = setup(validCfg(), { logger })
    await expect(ctx.host.boot()).resolves.toBeUndefined() // boot 的 info/warn 路径全抛也不崩
    const o = optsOf(ctx.calls, 'lixiao')
    expect(() => o.onEvent('error', { kind: 'server', message: 'x', fatal: false })).not.toThrow()
    expect(() => o.onEvent('warn', { reason: 'y' })).not.toThrow()
    await expect(ctx.host.converge(validCfg({ bots: [] }))).resolves.toBeTruthy() // 删除路径的 ORPHAN warn 也吞得住
  })
})
