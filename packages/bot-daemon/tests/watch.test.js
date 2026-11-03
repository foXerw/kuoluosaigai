// @vitest-environment node
// Task 8：配置热重载 watcher 测试。brief Step 1 的四条用例名逐字保留，另补两条接线钉：
// stop() 不留活句柄（daemon 常驻 + Task 9 --once 干净退出的前提）、R27 换 key 必须可见
// （真 loadConfig 缓存击穿重导入，rotated apiKey 在下一次 settle 到场——缓存复用会把它
// 洗成"配置没变"，正是 R27 判死刑的"静默忽略"类缺陷）。
// 纪律：全部时序走注入假时钟（vi.useFakeTimers + setSystemTime(0)，断言差值不赌真钟），
// 临时文件只在 os.tmpdir()，process.env 在 finally 还原，清理守卫到位。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigLoadError, loadConfig, validateConfig } from '../config.js'
import { createConfigWatcher } from '../watch.js'

// —— fixture：一律过 validateConfig 的合法形状（cfg 权威），bots 文案各态可辨 ——
function raw(over) {
  return Object.assign(
    {
      name: 'lab-vm',
      serverUrl: 'wss://kuoluosaigai.com',
      provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-static-key', model: 'deepseek-chat' },
      bots: [{ id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula' }],
    },
    over || {},
  )
}

function validCfg(r) {
  const res = validateConfig(r)
  if (!res.ok) throw new Error('测试 fixture 非法: ' + res.errors.join('; '))
  return res.cfg
}

// 假配置文件：content 是当前盘上态；置为 Error 即"这轮读到坏"。loadCalls 记调用次数，
// 钉死"每轮真调一次 load，绝不缓存复用"。
function fakeFile(initial) {
  const state = { value: initial, loadCalls: 0 }
  async function load() {
    state.loadCalls += 1
    if (state.value instanceof Error) throw state.value
    return state.value
  }
  return {
    load,
    set(v) {
      state.value = v
    },
    calls() {
      return state.loadCalls
    },
  }
}

// onSettle 记账器：记录 (假时钟时刻, cfg)，返回 host 同款 Report 形状（Task 7 契约）。
function settleRecorder() {
  const seen = []
  function onSettle(cfg) {
    seen.push({ t: Date.now(), cfg })
    return Promise.resolve({
      added: [],
      removed: [],
      changed: [],
      unchanged: [],
      limitsChanged: false,
      serverUrlChanged: false,
      providerChanged: false,
      restartRequired: false,
      needsBotRestart: false,
    })
  }
  return { seen, onSettle }
}

function fakeLogger() {
  const rec = { info: [], warn: [], error: [] }
  return {
    rec,
    info: (msg, fields) => rec.info.push({ msg, fields }),
    warn: (msg, fields) => rec.warn.push({ msg, fields }),
    error: (msg, fields) => rec.error.push({ msg, fields }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Task 8：配置热重载 watcher（轮询 + debounce + 坏读不动作）', () => {
  it('抖动合并：连续 3 次读到不同中间态，只在最后一次稳定 500ms 后 onSettle 一次（debounce）', async () => {
    const botOf = (persona) => [{ id: 'lixiao', name: '小李', persona, room: 'nebula' }]
    const file = fakeFile(raw({ bots: botOf('中间态一') }))
    const rec = settleRecorder()
    const w = createConfigWatcher({ load: file.load, onSettle: rec.onSettle })
    w.start()
    await vi.advanceTimersByTimeAsync(1000) // poll1 读到中间态一
    file.set(raw({ bots: botOf('中间态二') }))
    await vi.advanceTimersByTimeAsync(1000) // poll2 又变：上一轮的稳定证据作废，debounce 复位
    file.set(raw({ bots: botOf('最终态') }))
    await vi.advanceTimersByTimeAsync(1000) // poll3 再变
    await vi.advanceTimersByTimeAsync(1000) // poll4 == poll3 → 此刻才算稳定，起 500ms debounce
    expect(rec.seen.length).toBe(0)
    await vi.advanceTimersByTimeAsync(500) // 稳定 500ms 后才 hand-off，且只一次
    expect(rec.seen.length).toBe(1)
    expect(rec.seen[0].cfg.bots[0].persona).toBe('最终态')
    expect(rec.seen[0].cfg).toEqual(validCfg(raw({ bots: botOf('最终态') })))
    expect(file.calls()).toBe(4) // 每轮恰好一次 load，从不缓存复用（R27 前提）
    await vi.advanceTimersByTimeAsync(3000) // 其后内容不再变：不许二次回调
    expect(rec.seen.length).toBe(1)
    w.stop()
  })

  it('load 抛异常（半写文件/语法错误）→ 不回调 onSettle，保留上一份好配置（Review Focus #4）', async () => {
    const G = raw()
    const H = raw({ bots: [{ id: 'lixiao', name: '小李', persona: '新的人格', room: 'nebula' }] })
    const file = fakeFile(G)
    const rec = settleRecorder()
    const log = fakeLogger()
    const w = createConfigWatcher({ load: file.load, onSettle: rec.onSettle, logger: log })
    w.start()
    await vi.advanceTimersByTimeAsync(2500) // 两轮同读 → G settle（上一份好配置 = G）
    expect(rec.seen.length).toBe(1)

    // 坏态之间一律整轮推进（轮询 1000ms）——每种坏态都真被 poll 读到过，断言才有主
    file.set(new ConfigLoadError('unparsable', 'saigai.config.mjs', 'Unexpected token }', null))
    await vi.advanceTimersByTimeAsync(1000) // 3000：读到 unparsable → 不动作
    file.set(new ConfigLoadError('unreadable', 'saigai.config.mjs', 'ENOENT', null))
    await vi.advanceTimersByTimeAsync(1000) // 4000：读到 unreadable → 不动作
    expect(rec.seen.length).toBe(1)
    file.set(raw({ bots: 'not-an-array' })) // 解析成功但校验失败：同属"坏读"，同样不 hand-off
    await vi.advanceTimersByTimeAsync(2000) // 5000/6000 连续两轮同一畸形内容 → 依旧零回调
    expect(rec.seen.length).toBe(1)
    // kind 分流进了日志（instanceof + .kind，不是猜 message）；且 key 值绝不进日志（A1/A3）
    expect(log.rec.warn.some((e) => String(e.msg).includes('unparsable'))).toBe(true)
    expect(log.rec.warn.some((e) => String(e.msg).includes('unreadable'))).toBe(true)
    expect(log.rec.warn.some((e) => String(e.msg).includes('非法'))).toBe(true)
    expect(JSON.stringify(log.rec)).not.toContain('sk-static-key')

    file.set(G) // 编辑器撤销，文件回到上一份好内容
    await vi.advanceTimersByTimeAsync(2500) // 指纹 == 已结算 → 不重复收敛（"静默保留"的落点）
    expect(rec.seen.length).toBe(1)

    file.set(H) // watcher 没被坏读打死：好变更照常收敛
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(2)
    expect(rec.seen[1].cfg.bots[0].persona).toBe('新的人格')
    w.stop()
  })

  it('解析成功但 bots: [] → 视为合法空集合，回调（用户真想全停）与畸形读盘要能区分', async () => {
    const file = fakeFile(raw())
    const rec = settleRecorder()
    const w = createConfigWatcher({ load: file.load, onSettle: rec.onSettle })
    w.start()
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(1) // 基线：G 结算一次

    file.set(raw({ bots: [] })) // 合法"我要零 bot"：解析+校验双成功，必须照常 hand-off
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(2)
    expect(rec.seen[1].cfg.bots).toEqual([])

    file.set({ name: 'lab-vm', bots: [] }) // 对照的畸形态：同样"空"，但 provider 缺失 → 校验失败，不许 hand-off
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(2)

    file.set(raw({ bots: [] })) // 回到已结算的合法空集合：指纹相同，不重复收敛
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(2)
    w.stop()
  })

  it('检测后 ≤2s 完成收敛：从最后一次 mtime 变化到 onSettle 被消费的注入时钟差 ≤2000ms（Q10 口径）', async () => {
    const G = raw()
    const H = raw({ name: 'lab-vm-2' })
    const file = fakeFile(G)
    const rec = settleRecorder()
    const w = createConfigWatcher({ load: file.load, onSettle: rec.onSettle })
    w.start()
    await vi.advanceTimersByTimeAsync(2500) // G 在 2500 结算
    expect(rec.seen.map((s) => s.t)).toEqual([2500])

    file.set(H) // 最后一次内容变更恰好落在 2500（基线结算的同一瞬间）
    await vi.advanceTimersByTimeAsync(2000) // 3000 poll 首次读到（检测点），4000 poll 同读 → 稳定
    await vi.advanceTimersByTimeAsync(500) // debounce 到点 → onSettle 被消费
    expect(rec.seen.length).toBe(2)
    const consumed = rec.seen[1].t
    expect(consumed).toBe(4500) // 确定性时序：检测 3000 → 稳定 4000 → debounce 500
    expect(consumed - 3000).toBeLessThanOrEqual(2000) // 计划权威口径"检测后 ≤2s"
    expect(consumed - 2500).toBeLessThanOrEqual(2000) // sketch 口径"从最后一次变化到消费 ≤2s"
    w.stop()
  })

  it('stop() 清掉它创建的全部定时器：停后不再轮询，已起未发的 debounce 也不回调', async () => {
    const G = raw()
    const file = fakeFile(G)
    const rec = settleRecorder()
    const w = createConfigWatcher({ load: file.load, onSettle: rec.onSettle })
    w.start()
    w.start() // 幂等：两次 start 仍只有一个轮询间隔（不叠加句柄）
    await vi.advanceTimersByTimeAsync(2000) // 两轮同读 → debounce 已起（2500 才会发）
    expect(file.calls()).toBe(2)
    w.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(rec.seen.length).toBe(0) // debounce 被清，没借尸还魂
    expect(file.calls()).toBe(2) // 轮询被清，没多读一轮
    w.stop() // 重复 stop 无害
    w.start() // 停后可重启（Task 9 的接线面）
    await vi.advanceTimersByTimeAsync(2500)
    expect(rec.seen.length).toBe(1)
    w.stop()
  })

  it('R27 端到端：每轮真做重导入（缓存击穿），process.env 换 key 在下一次 settle 可见', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-watch-t8-'))
    const file = path.join(dir, 'saigai.config.mjs')
    const prevKey = process.env.KUO_LLM_KEY
    const rec = settleRecorder()
    const io = { resolved: 0 }
    let w = null
    try {
      fs.writeFileSync(
        file,
        'export default {\n' +
          "  name: 'lab-vm',\n" +
          '  provider: { baseUrl: \'https://api.deepseek.com/v1\', apiKey: process.env.KUO_LLM_KEY, model: \'deepseek-chat\' },\n' +
          "  bots: [{ id: 'lixiao', name: '小李', persona: 'p', room: 'nebula' }],\n" +
          '}\n',
      )
      // 假时钟能拨 debounce/轮询，拨不动真实 import 的事件循环回合：每步推进后用一个
      // 真 IO 自旋把挂起的模块读取排干（条件满足即止，非固定 sleep），两次连续轮询
      // 才可能在假时间轴上对齐成"稳定"。
      const drainTo = async (cond, label) => {
        for (let i = 0; i < 100; i += 1) {
          await fs.promises.stat(file)
          if (cond()) return
        }
        throw new Error('真实 IO 排干失败：' + label)
      }
      process.env.KUO_LLM_KEY = 'sk-KEY-ONE-0001'
      w = createConfigWatcher({
        load: () =>
          loadConfig(file).then((r) => {
            io.resolved += 1
            return r
          }),
        onSettle: rec.onSettle,
      })
      w.start()
      await vi.advanceTimersByTimeAsync(1000)
      await drainTo(() => io.resolved >= 1, 'poll1 导入落地') // 首轮读到 key ONE
      await vi.advanceTimersByTimeAsync(1000)
      await drainTo(() => io.resolved >= 2, 'poll2 导入落地') // 同读 → 稳定，起 debounce
      await vi.advanceTimersByTimeAsync(500)
      await drainTo(() => rec.seen.length >= 1, '第一次 settle')
      expect(rec.seen[0].cfg.provider.apiKey).toBe('sk-KEY-ONE-0001')

      process.env.KUO_LLM_KEY = 'sk-KEY-TWO-0002' // 换 key：配置文件的字节都没变
      await vi.advanceTimersByTimeAsync(1000) // 3000：缓存击穿重求值 → apiKey 变 → 新指纹
      await drainTo(() => io.resolved >= 3, 'poll3 导入落地')
      await vi.advanceTimersByTimeAsync(1000)
      await drainTo(() => io.resolved >= 4, 'poll4 导入落地') // 稳定
      await vi.advanceTimersByTimeAsync(500) // 4500：settle
      await drainTo(() => rec.seen.length >= 2, '第二次 settle')
      expect(rec.seen.length).toBe(2)
      expect(rec.seen[1].cfg.provider.apiKey).toBe('sk-KEY-TWO-0002')
      // 若 watcher（或上游）缓存复用了模块/结果，poll3-4 会永远读到 ONE：指纹不变 →
      // 永远等不到第二次 settle → 上面的 drainTo 以 "第二次 settle" 失败示人。
    } finally {
      if (w) w.stop()
      if (prevKey === undefined) delete process.env.KUO_LLM_KEY
      else process.env.KUO_LLM_KEY = prevKey
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
