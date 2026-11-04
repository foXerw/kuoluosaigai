// @vitest-environment node
// Task 9：CLI 组装测试（Task 10 追加 status 子命令与 run 的控制面接线）。优先单测注入依赖的
// main(argv)（brief 明示），真组装走 --once 一条 + status 两条真回环（rpc.js 起的 127.0.0.1:0
// 服务，finally 必 close），spawn 冒烟只留一条且带硬超时。
// 钉死：启动六步顺序（boot 后 control.start 再 watcher）、R21 句柄式 release（无 releaseLock）、
// holder 两文案 + 双双退 3 非零（A5 不静默）、退出码 0/1/2/3/4、关停顺序
// watcher.stop→control.close→host.shutdown→lock.release、--once 零残留句柄（且不建控制面）、
// status 三态文案各异（missing/stale/401）+ 粘滞 restartRequired 置顶 + 数据年龄 + 孤儿暴露（Q12/R28/R31）、
// Task 8 concern#4 的接线层短路、§8.2 help 文本不提 pair/revoke、A1 key 不落输出。
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateConfig, ConfigLoadError, loadConfig } from '../config.js'
import { createConfigWatcher } from '../watch.js'
import { main } from '../cli.js'
// 注意：不**静态** import '../rpc.js'——cli.js 对 rpc.js 是延迟加载（启动模块图体积会
// 挤占兄弟测试文件的 IO 窗口，见 cli.js 头注释）；本文件两条真回环用例在**测试体内**
// await import，触发点落在 spawn 长测之后、watch.test 早已收工的时段。

const SECRET = 'sk-SUPERSECRET-do-not-leak-9f3a'

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-cli-test-'))
})
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

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

function startupCfg(over) {
  const res = validateConfig(makeRaw(over))
  if (!res.ok) throw new Error('测试 fixture 非法: ' + res.errors.join('; '))
  return res.cfg
}

function reportFixture() {
  return {
    added: [],
    removed: [],
    changed: [],
    unchanged: ['lixiao', 'aqin'],
    limitsChanged: false,
    serverUrlChanged: false,
    providerChanged: false,
    restartRequired: false,
    needsBotRestart: false,
  }
}

// 与 host.test 同规格的假 runner：真 WS 绝不构造。
function spyRunner() {
  return {
    start() {},
    stop() {},
    switchRoom() {},
    clearBuffer() {},
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
}

function ctx(over) {
  const x = over || {}
  const order = []
  const out = []
  const errs = []
  const log = { info: [], warn: [], error: [] }
  const signals = {}
  const calls = { convergeWith: [], hostOpts: [], watcherOpts: null, lockArgs: null }
  const cfg = x.cfg || startupCfg()
  const host = x.host || {
    boot: async () => {
      if (x.bootErr) throw x.bootErr
      order.push('host.boot')
    },
    converge: async (next) => {
      order.push('host.converge')
      calls.convergeWith.push(next)
      if (x.convergeErr) throw x.convergeErr
      return reportFixture()
    },
    snapshot: () => ({ meta: {}, bots: [] }),
    shutdown: () => {
      order.push('host.shutdown')
    },
  }
  const lockResult =
    x.lock === undefined ? { ok: true, tookOver: !!x.tookOver, release: () => order.push('lock.release') } : x.lock
  const deps = {
    print: (l) => out.push(String(l)),
    printErr: (l) => errs.push(String(l)),
    logger: {
      info: (m, f) => log.info.push({ m, f }),
      warn: (m, f) => log.warn.push({ m, f }),
      error: (m, f) => log.error.push({ m, f }),
    },
    load:
      x.load ||
      (async () => {
        if (x.loadThrow) throw x.loadThrow
        return x.raw !== undefined ? x.raw : cfg
      }),
    acquireLock:
      x.acquireLock ||
      ((o) => {
        order.push('acquireLock')
        calls.lockArgs = o
        if (x.lockErr) throw x.lockErr
        return lockResult
      }),
    createStore: (o) => {
      order.push('createStore')
      return (
        x.store || {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
          readOrphans: () => ({}),
          path: path.join(o.dir, 'state.json'),
        }
      )
    },
    createHost: (o) => {
      order.push('createHost')
      calls.hostOpts.push(o)
      return host
    },
    createWatcher: (o) => {
      order.push('createWatcher')
      calls.watcherOpts = o
      return {
        start: () => order.push('watcher.start'),
        stop: () => order.push('watcher.stop'),
      }
    },
    startControlServer:
      x.startControlServer ||
      (async (o) => {
        order.push('control.start')
        calls.controlOpts = o
        return {
          port: 41517,
          rpcPath: path.join(o.dir, 'rpc.json'),
          close: () => {
            order.push('control.close')
            if (x.controlCloseErr) throw x.controlCloseErr
            return Promise.resolve()
          },
        }
      }),
    readRpcFile: x.readRpcFile || (() => ({ ok: false, why: 'missing', path: '/virtual/rpc.json' })),
    homedir: () => tmpRoot,
    now: () => 1730000000000,
    onSignal: (name, cb) => {
      signals[name] = cb
      return () => {
        delete signals[name]
      }
    },
  }
  return { deps, order, out, errs, log, signals, host, calls, cfg, lockResult }
}

async function until(cond, tries) {
  const max = tries || 50
  for (let i = 0; i < max; i += 1) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('until 超时：条件未成立')
}

// —— 用法与退出码 2 ——

it('未知子命令：打印用法退 2；§8.2 红线——help 不提 pair/revoke', async () => {
  const c = ctx({})
  const code = await main(['bogus'], c.deps)
  expect(code).toBe(2)
  const joined = c.out.concat(c.errs).join('\n')
  expect(joined).toContain('saigai-bot run')
  expect(joined).toContain('validate')
  expect(joined).toContain('doctor')
  expect(joined).toContain('saigai-bot status')
  expect(joined).not.toContain('pair')
  expect(joined).not.toContain('revoke')
})

it('空 argv 也是用法错误退 2；help 子命令打印用法退 0', async () => {
  const a = ctx({})
  expect(await main([], a.deps)).toBe(2)
  const b = ctx({})
  expect(await main(['help'], b.deps)).toBe(0)
  expect(b.out.join('\n')).toContain('saigai-bot doctor')
})

// —— validate ——

it('validate 合法 → 0 且 stdout 报 OK；非法 → 1 且 stdout 列出 errors', async () => {
  const ok = ctx({})
  expect(await main(['validate', '/tmp/whatever.js'], ok.deps)).toBe(0)
  expect(ok.out.join('\n')).toContain('OK')

  const badRaw = makeRaw()
  badRaw.bots[0].room = 'NO!'
  const bad = ctx({ raw: badRaw })
  const code = await main(['validate', '/tmp/whatever.js'], bad.deps)
  expect(code).toBe(1)
  expect(bad.out.join('\n')).toContain('bots[0].room')
  expect(joinedOf(bad)).not.toContain(SECRET)
})

it('validate 缺参数 → 2；ConfigLoadError → 1 且 kind 如实透传（不继承错标签）', async () => {
  const miss = ctx({})
  expect(await main(['validate'], miss.deps)).toBe(2)

  const err = ctx({ loadThrow: new ConfigLoadError('unparsable', 'x.js', '半写坏语法') })
  expect(await main(['validate', '/tmp/x.js'], err.deps)).toBe(1)
  expect(err.errs.join('\n')).toContain('unparsable')
})

// —— run：锁的两条文案与退出码 3（R21 + T6 parked Minor③）——

it('run 锁被持有（有 PID）→ 打印「已被 PID n 持有（最后一次观察到的持有者，可能已不存活）」退 3，不建 host', async () => {
  const c = ctx({
    lock: { ok: false, holder: { pid: 4242, startedAt: 1 } },
  })
  const code = await main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(3)
  const line = c.errs.join('\n')
  expect(line).toContain('已被 PID 4242 持有（最后一次观察到的持有者，可能已不存活）')
  expect(line).not.toContain('PID null')
  expect(c.order).not.toContain('createHost') // 拿不到锁就一个部件都不碰
})

it('run 锁被持有（持有者未知）→ 换文案仍退 3，绝不印出 null、绝不静默（A5）', async () => {
  const c = ctx({ lock: { ok: false, holder: { pid: null, startedAt: null } } })
  const code = await main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(3)
  const line = c.errs.join('\n')
  expect(line).toContain('持有者未知')
  expect(line).not.toContain('null')
  expect(c.errs.length).toBeGreaterThan(0)
})

it('run 锁检查自身抛错（EACCES 等）→ 非零退出且有出声，绝不静默', async () => {
  const c = ctx({ lockErr: Object.assign(new Error('locked dir'), { code: 'EACCES' }) })
  const code = await main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).not.toBe(0)
  expect(c.errs.join('\n')).toContain('EACCES')
})

it('run 配置非法 → 1 且逐行 errors，锁都不碰', async () => {
  const c = ctx({ raw: makeRaw({ name: '' }) })
  const code = await main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(1)
  expect(c.errs.join('\n')).toContain('name: 必须是非空字符串')
  expect(c.order).not.toContain('acquireLock')
})

it('run 接管陈旧锁 → WARN 留痕（§7.4）', async () => {
  const c = ctx({ tookOver: true })
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT)
  c.signals.SIGINT()
  expect(await p).toBe(0)
  expect(c.log.warn.map((e) => e.m).join(' | ')).toContain('接管陈旧锁')
})

// —— run --once：六步顺序与干净退出 ——

it('run --once：boot → converge → host.shutdown → lock.release，退 0，watcher 与控制面都不建（不留任何句柄）', async () => {
  const c = ctx({})
  const code = await main(['run', '--once', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(0)
  expect(c.order).toEqual(['acquireLock', 'createStore', 'createHost', 'host.boot', 'host.converge', 'host.shutdown', 'lock.release'])
  expect(c.order).not.toContain('createWatcher')
  expect(c.order).not.toContain('watcher.start')
  expect(c.order).not.toContain('control.start') // Task 10：--once 不建控制面（「零残留句柄」的字面承诺）
})

it('run --once 收敛抛错 → 非零且释放锁、关停 host（失败路径也不留锁）', async () => {
  const c = ctx({ convergeErr: new Error('deck 坏了') })
  const code = await main(['run', '--once', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(1)
  expect(c.order).toContain('lock.release')
  expect(c.order).toContain('host.shutdown')
})

it('run boot 抛错 → 1，锁照样释放', async () => {
  const c = ctx({ bootErr: new Error('起不来') })
  const code = await main(['run', '--once', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(1)
  expect(c.order).toContain('lock.release')
  expect(c.order).not.toContain('host.converge')
})

// —— run 常驻：信号关停顺序与句柄纪律 ——

it('run 常驻：SIGINT → watcher.stop → control.close → host.shutdown → lock.release（钉死相对序），监听器随退出摘除', async () => {
  const c = ctx({})
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT && c.signals.SIGTERM)
  expect(c.order).toEqual(['acquireLock', 'createStore', 'createHost', 'host.boot', 'control.start', 'createWatcher', 'watcher.start'])
  // Task 10（Q12）：控制面在 boot 成功之后、watcher 之前起——快照读的是已就位的 host；
  // control.close 插在 watcher.stop 与 host.shutdown 之间——先关「新读数的门」，再拆店。
  c.signals.SIGINT()
  expect(await p).toBe(0)
  expect(c.order.slice(7)).toEqual(['watcher.stop', 'control.close', 'host.shutdown', 'lock.release'])
  expect(c.signals.SIGINT).toBeUndefined()
  expect(c.signals.SIGTERM).toBeUndefined()
})

it('SIGTERM 连击两次也只关停一次（幂等，release 不双跑）', async () => {
  const c = ctx({})
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGTERM)
  const term = c.signals.SIGTERM // 留住引用：第一次关停后监听器已被摘除，二次触发要打在旧闭包上（done 守卫）
  term()
  term()
  expect(await p).toBe(0)
  expect(c.order.filter((o) => o === 'lock.release').length).toBe(1)
  expect(c.order.filter((o) => o === 'control.close').length).toBe(1) // 控制面 close 同样只跑一次
})

// —— Task 10：run 的控制面接线（Q12）——

it('run 控制面接线：snapshot 回调真读 host.snapshot；数据目录传的是 --data-dir', async () => {
  const c = ctx({})
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.calls.controlOpts)
  expect(typeof c.calls.controlOpts.snapshot).toBe('function')
  expect(c.calls.controlOpts.snapshot()).toEqual({ meta: {}, bots: [] }) // 假 host 的 fixture 原样透传
  expect(c.calls.controlOpts.dir).toBe('/tmp/whatever')
  c.signals.SIGINT()
  await p
})

it('控制服务起不来 → FAIL 大声但 daemon 照跑、SIGINT 关停仍退 0（观测面炸不拖垮 bot 面，A5 不静默）', async () => {
  const c = ctx({
    startControlServer: async () => {
      throw new Error('rpc.json 写不进去：EACCES')
    },
  })
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT && c.signals.SIGTERM)
  expect(c.errs.join('\n')).toContain('控制服务未能启动')
  expect(c.errs.join('\n')).toContain('EACCES')
  expect(c.order).toContain('watcher.start') // bot 面没被观测面拖死
  c.signals.SIGINT()
  expect(await p).toBe(0)
  expect(c.order).not.toContain('control.close') // 没起起来就没有可关的
})

it('control.close 炸 → R34 退 4，后续步骤照跑（关停步骤失败不许谎报干净停止）', async () => {
  const c = ctx({ controlCloseErr: new Error('close 卡进内部异常') })
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT)
  c.signals.SIGINT()
  expect(await p).toBe(4)
  expect(joinedOf(c)).toContain('关停步骤失败')
  expect(c.order).toContain('lock.release') // 一步炸不连累后两步
})

// —— Task 8 concern #4：接线层短路启动期空 diff converge ——

it('watcher onSettle 首拍同配置 → 短路不调 host.converge；真变更照常 converge；回滚到旧值不误短路', async () => {
  const c = ctx({})
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.calls.watcherOpts)
  const onSettle = c.calls.watcherOpts.onSettle

  // ①启动配置原样重交（Task 8 的空 diff settle）→ 短路，且返回 Report 形状（R28 日志口径）
  const sameCfg = JSON.parse(JSON.stringify(c.cfg))
  const r1 = await onSettle(sameCfg)
  expect(c.order).not.toContain('host.converge')
  expect(r1.added).toEqual([])
  expect(r1.removed).toEqual([])
  expect(r1.changed).toEqual([])
  expect(r1.restartRequired).toBe(false)

  // ②真变更 → converge 被调
  const changed = JSON.parse(JSON.stringify(c.cfg))
  changed.bots[0].name = '小李酱'
  const r2 = await onSettle(changed)
  expect(c.order).toContain('host.converge')
  expect(r2).toEqual(reportFixture())

  // ③回滚到**启动值**：host 现在停在 changed，绝不能被「等于启动 cfg」短路骗过
  await onSettle(sameCfg)
  expect(c.calls.convergeWith.length).toBe(2)
  expect(c.calls.convergeWith[1]).toEqual(sameCfg)

  c.signals.SIGINT()
  await p
})

it('watcher 的 load 接线指向同一 --config 路径（热重载读的是启动读的那份文件）', async () => {
  const dir = freshDir()
  const seen = []
  const c = ctx({
    load: async (p) => {
      seen.push(p)
      return c.cfg
    },
  })
  const p = main(['run', '--config', path.join(dir, 'my.config.js'), '--data-dir', dir], c.deps)
  await until(() => c.calls.watcherOpts)
  await c.calls.watcherOpts.load()
  c.signals.SIGINT()
  await p
  expect(seen.length).toBe(2)
  expect(seen[0]).toBe(seen[1])
  expect(seen[0]).toContain('my.config.js')
})

// —— 真组装 --once（Task 5/6/7 合体首次端到端；假 runner、真锁、真 store）——

it('run --once 真组装：真 loadConfig/锁/state/host 走通，退 0、锁文件已删、真 WS 从未构造', async () => {
  const dir = freshDir()
  const cfgPath = path.join(dir, 'saigai-bot.config.js')
  fs.writeFileSync(
    cfgPath,
    'export default ' +
      JSON.stringify({
        name: 'ci-vm',
        serverUrl: 'ws://localhost:1',
        provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: SECRET, model: 'deepseek-chat' },
        bots: [{ id: 'lixiao', name: '小李', persona: '短', room: 'nebula' }],
      }) +
      '\n',
  )
  const c = ctx({})
  const code = await main(['run', '--once', '--config', cfgPath, '--data-dir', dir], {
    print: c.deps.print,
    printErr: c.deps.printErr,
    logger: c.deps.logger,
    now: () => 1730000000000,
    WebSocketImpl: function NoRealWS() {
      throw new Error('测试里禁止构造真 WS')
    },
    createRunner: spyRunner,
  })
  expect(code).toBe(0)
  expect(fs.existsSync(path.join(dir, 'saigai-bot.lock'))).toBe(false) // release 真删了锁
  expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true) // dispose 的 B12 冲刷
  expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(SECRET) // A1：真 store 落盘剥了 key
  expect(c.out.join('\n') + c.errs.join('\n')).not.toContain(SECRET)
})

// —— spawn 冒烟（仅此一条，硬超时）——

it('spawn 冒烟：bin validate 合法配置 → 子进程退 0 且 stdout 含 OK', async () => {
  const dir = freshDir()
  const cfgPath = path.join(dir, 'ok.config.js')
  fs.writeFileSync(
    cfgPath,
    'export default ' +
      JSON.stringify({
        name: 'smoke',
        provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-not-a-secret-in-stdout', model: 'm' },
        bots: [{ id: 'lixiao', name: '小李', persona: '短', room: 'nebula' }],
      }) +
      '\n',
  )
  const bin = fileURLToPath(new URL('../bin/saigai-bot.js', import.meta.url))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'validate', cfgPath], { cwd: path.resolve(bin, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] })
    let outStr = ''
    child.stdout.on('data', (d) => {
      outStr += String(d)
    })
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('spawn 冒烟超时（20s）'))
    }, 20000)
    // close（非 exit）：等 stdio 管道排空再断言 outStr——exit 后 stdout data 理论上可迟到（轮 2 消抖）
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode, outStr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  expect(result.exitCode).toBe(0)
  expect(result.outStr).toContain('OK')
}, 30000)

// —— 审查轮 1 · Important 1 回归网：spawn 打 doctor 的 WS 超时路径，断言**子进程自己退出** ——

it('spawn blackhole：黑洞 WS 端点下 doctor 超时判 FAIL 后必须自行退出（不关套接字=悬挂整个体检仪）', async () => {
  // 黑洞服务器：收下 TCP，**永不**应答 upgrade——§5「VPS 出网被静默黑洞」的最小复现体。
  const held = []
  const blackhole = net.createServer((sock) => held.push(sock))
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r))
  const wsPort = blackhole.address().port
  // provider 指向**立即拒绝**的端口：网络类失败秒判，把等待预算留给 WS 超时本体。
  const dead = net.createServer()
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const httpPort = dead.address().port
  await new Promise((r) => dead.close(r))
  const dir = freshDir()
  const cfgPath = path.join(dir, 'blackhole.config.js')
  fs.writeFileSync(
    cfgPath,
    'export default ' +
      JSON.stringify({
        name: 'probe',
        serverUrl: 'ws://127.0.0.1:' + wsPort,
        provider: { baseUrl: 'http://127.0.0.1:' + httpPort, apiKey: 'sk-throwaway', model: 'm' },
        bots: [{ id: 'b1', name: 'n', persona: 'p', room: 'nebula' }],
      }) +
      '\n',
  )
  const bin = fileURLToPath(new URL('../bin/saigai-bot.js', import.meta.url))
  try {
    const HARNESS_MS = 25000 // doctor 自己要等满 WS_TIMEOUT_MS=10s（外加 provider 一次重试 1s）；到点没自己退=悬挂实锤
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'doctor', '--config', cfgPath, '--data-dir', dir], {
        cwd: path.resolve(bin, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let outStr = ''
      child.stdout.on('data', (d) => {
        outStr += String(d)
      })
      child.stderr.on('data', () => {})
      const killer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('spawn blackhole：doctor 未自行退出（Important 1 悬挂复现）'))
      }, HARNESS_MS)
      // close（非 exit）：stdio 排空后才断言 outStr；25s killer 仍是超时唯一权威——
      // 悬挂形态=「FAIL 已印、exitCode 已定、close 不来」，killer 到点必红（轮 1 实测如此）。
      child.on('close', (exitCode) => {
        clearTimeout(killer)
        resolve({ exitCode, outStr })
      })
      child.on('error', (e) => {
        clearTimeout(killer)
        reject(e)
      })
    })
    expect(result.outStr).toContain('serverUrl WS 可达性')
    expect(result.outStr).toContain('超时')
    expect(result.exitCode).toBe(1) // 体检结论照常是 1，但进程**自己**走人
  } finally {
    for (const s of held) s.destroy()
    await new Promise((r) => blackhole.close(r))
  }
}, 40000)

// —— 审查轮 1 · R33（轮 2 改造）：ConfigLoadError.message 在构造点净化，三处打印面各成独立用例 ——
// 轮 1 的空转自纠：SECRET 全串（31 字符）**从不**出现在原始 message 里——V8 的输入切片窗口
// 只有 ~10 字符+省略号。故 `not.toContain(SECRET)` 在净化器回归时也能绿=真空守卫。
// 针（needle）改为真实泄漏形态：窗口前缀 + 切片措辞；每面单独成 it，净化器一旦被拆掉，
// **三面各自变红**（轮 2 用回退实验逐面验证过：临时拆掉构造点净化，三个 it 独立转红再还原）。

const LEAK_WINDOW = SECRET.slice(0, 10) // 'sk-SUPERSE'——V8 实际嵌进原始 message 的窗口内容
const RAW_PHRASE = 'Unexpected token' // 切片形态的措辞头，净化层必须剥掉

function leakyCfgFile() {
  const dir = freshDir()
  const cfgPath = path.join(dir, 'leaky.config.js')
  // 审查探针同款场景：求值期 JSON.parse 抛错，V8 把输入切片（含 key 头部）嵌进 message。
  // 实测钉形（Node 24）：输入以**非 JSON 开头**才走「Unexpected token + 输入切片」形态——
  // 合法前缀（如 "1"+key）走 position 形态、本身不含切片；净化器两头都必须成立。
  fs.writeFileSync(cfgPath, 'export default JSON.parse("' + SECRET + '")\n')
  return { dir, cfgPath }
}

it('R33·①validate/run stderr 面：无切片窗口前缀、无切片措辞（净化器回归可独立变红）', async () => {
  const { cfgPath } = leakyCfgFile()
  const v = ctx({ load: (p) => loadConfig(p) })
  expect(await main(['validate', cfgPath], v.deps)).toBe(1)
  expect(joinedOf(v)).not.toContain(LEAK_WINDOW)
  expect(joinedOf(v)).not.toContain(RAW_PHRASE)
  expect(joinedOf(v)).not.toContain(SECRET) // 全串留作未来窗口变宽形态的腰带
  expect(joinedOf(v)).toContain('unparsable') // 净化不能吃掉定位信息的全部残值：kind 仍在场
})

it('R33·②doctor 输出面：同上（配置坏时依赖项走「未实测」，零真实网络）', async () => {
  const { dir, cfgPath } = leakyCfgFile()
  const d = ctx({ load: (p) => loadConfig(p) })
  expect(await main(['doctor', '--config', cfgPath, '--data-dir', dir], d.deps)).toBe(1)
  expect(joinedOf(d)).not.toContain(LEAK_WINDOW)
  expect(joinedOf(d)).not.toContain(RAW_PHRASE)
  expect(joinedOf(d)).not.toContain(SECRET)
})

it('R33·③watcher warn 面：同上（watch.js:175 打印点**不动**，由上游构造点净化——R33 裁定）', async () => {
  const { cfgPath } = leakyCfgFile()
  const warns = []
  const watcher = createConfigWatcher({
    load: () => loadConfig(cfgPath),
    onSettle: () => {},
    logger: { info: () => {}, warn: (m) => warns.push(String(m)), error: () => {} },
    intervalMs: 25,
    debounceMs: 10,
  })
  watcher.start()
  try {
    // 真 IO 轮询用真实时间等（until 的 setImmediate 自旋不消耗 25ms 墙钟）：最长 2s。
    for (let i = 0; i < 80 && warns.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
  } finally {
    watcher.stop()
  }
  const joined = warns.join('\n')
  expect(joined).toContain('unparsable')
  expect(joined).not.toContain(LEAK_WINDOW)
  expect(joined).not.toContain(RAW_PHRASE)
  expect(joined).not.toContain(SECRET)
})

it('R33·④构造点直证：message 净化且保留行位残值，cause 原文逐字（R33「留 .cause」条款）', async () => {
  const { cfgPath } = leakyCfgFile()
  const err = await loadConfig(cfgPath).then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(ConfigLoadError)
  expect(err.kind).toBe('unparsable')
  expect(err.message).not.toContain(LEAK_WINDOW)
  expect(err.message).not.toContain(RAW_PHRASE)
  expect(err.message).not.toContain(SECRET)
  expect(err.cause).toBeInstanceOf(Error)
  const causeMsg = String(err.cause.message)
  expect(causeMsg).toContain(LEAK_WINDOW)
  expect(causeMsg).toContain(RAW_PHRASE)

  // position 形态（合法 JSON 前缀+后续垃圾）：净化后行位数字必须**仍在** message 里
  // （Review Focus #1「指出行位」的残值条款——净化剥的是源文，不是坐标）。
  const posDir = freshDir()
  const posPath = path.join(posDir, 'pos.config.js')
  fs.writeFileSync(posPath, 'export default JSON.parse("1' + SECRET + 'x")\n')
  const posErr = await loadConfig(posPath).then(
    () => null,
    (e) => e,
  )
  expect(posErr).toBeInstanceOf(ConfigLoadError)
  expect(posErr.message).toContain('position')
  expect(posErr.message).not.toContain(SECRET)
})

// —— 审查轮 1 · R34：关停步骤炸 ≠ 干净停止，常驻路径退 4（--once 同为 4，converge 炸的 1 优先）——

it('R34 常驻：host.shutdown 抛错 → 退 4，FAIL 出声且后续步骤照跑', async () => {
  const c = ctx({})
  c.host.shutdown = () => {
    c.order.push('host.shutdown')
    throw new Error('dispose 炸——B12 冲刷可能没落盘')
  }
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT)
  c.signals.SIGINT()
  expect(await p).toBe(4)
  expect(joinedOf(c)).toContain('关停步骤失败')
  expect(c.order).toContain('lock.release') // 一步炸不连累后一步
})

it('R34 --once：converge 好而关停步骤炸 → 4；converge 已炸（1）时 1 优先不被覆盖', async () => {
  const a = ctx({})
  a.host.shutdown = () => {
    throw new Error('dispose 炸')
  }
  expect(await main(['run', '--once', '--data-dir', '/tmp/whatever'], a.deps)).toBe(4)

  const b = ctx({ convergeErr: new Error('deck 坏了') })
  b.host.shutdown = () => {
    throw new Error('dispose 也炸')
  }
  expect(await main(['run', '--once', '--data-dir', '/tmp/whatever'], b.deps)).toBe(1)
})

// —— Task 10：status 子命令（Q12）——

const RPC_OK = { ok: true, path: '/virtual/rpc.json', info: { port: 41517, secret: 'ab'.repeat(16), pid: 4242, startedAt: 1730000000000 } }

function fakeRes(status, body) {
  return { status, text: async () => body }
}

it('status 用法：带位置参数或 --config → 2；help 文本含 status 与「Windows chmod 尽力而为、防线是回环+secret」', async () => {
  const a = ctx({})
  expect(await main(['status', '多余参数'], a.deps)).toBe(2)
  const b = ctx({})
  expect(await main(['status', '--config', '/x/y.js'], b.deps)).toBe(2)
  const h = ctx({})
  expect(await main(['help'], h.deps)).toBe(0)
  const usage = h.out.join('\n')
  expect(usage).toContain('saigai-bot status')
  expect(usage).toContain('Windows')
  expect(usage).toContain('尽力而为')
  expect(usage).toContain('127.0.0.1')
})

it('status 三态文案各自独立可辨（missing / stale 不可达 / 401 secret）——全退 1，绝不混写', async () => {
  const miss = ctx({}) // ctx 默认 readRpcFile → missing
  expect(await main(['status', '--data-dir', '/tmp/whatever'], miss.deps)).toBe(1)
  const missLine = miss.errs.join('\n')
  expect(missLine).toContain('未在运行')
  expect(missLine).not.toContain('陈旧')

  const stale = ctx({})
  const staleDeps = Object.assign({}, stale.deps, {
    readRpcFile: () => ({ ok: false, why: 'malformed', path: '/tmp/whatever/rpc.json' }),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], staleDeps)).toBe(1)
  const staleLine = stale.errs.join('\n')
  expect(staleLine).toContain('陈旧')
  expect(staleLine).not.toContain('未在运行')

  const refused = ctx({})
  const refusedDeps = Object.assign({}, refused.deps, {
    readRpcFile: () => RPC_OK,
    fetchImpl: async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41517'), { code: 'ECONNREFUSED' })
      throw new TypeError('fetch failed', { cause })
    },
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], refusedDeps)).toBe(1)
  expect(refused.errs.join('\n')).toContain('陈旧')
  expect(refused.errs.join('\n')).toContain('ECONNREFUSED')

  const denied = ctx({})
  const deniedDeps = Object.assign({}, denied.deps, {
    readRpcFile: () => RPC_OK,
    fetchImpl: async () => fakeRes(401, '{"error":"unauthorized"}'),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], deniedDeps)).toBe(1)
  expect(denied.errs.join('\n')).toContain('401')
  expect(denied.errs.join('\n')).toContain('secret')

  const unreadable = ctx({})
  const unreadableDeps = Object.assign({}, unreadable.deps, {
    readRpcFile: () => ({ ok: false, why: 'unreadable', path: '/tmp/whatever/rpc.json' }),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], unreadableDeps)).toBe(1)
  expect(unreadable.errs.join('\n')).toContain('读不出')
})

it('status 超时路径有界：fetchImpl 尊重 AbortSignal → 到点自断、退 1 报「超时」（陈旧门牌不许挂死 CLI）', async () => {
  const c = ctx({})
  const deps = Object.assign({}, c.deps, {
    readRpcFile: () => RPC_OK,
    statusTimeoutMs: 20,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
        })
      }),
  })
  const t0 = Date.now()
  expect(await main(['status', '--data-dir', '/tmp/whatever'], deps)).toBe(1)
  expect(c.errs.join('\n')).toContain('超时')
  expect(Date.now() - t0).toBeLessThan(2000) // 有界：20ms 就该收口，不许等默认 5s
})

it('status 渲染面：401 体不带诊断信息时也不印响应体（A3 不回显）；非 200/坏 JSON 各有独立文案', async () => {
  const notFound = ctx({})
  const nfDeps = Object.assign({}, notFound.deps, {
    readRpcFile: () => RPC_OK,
    fetchImpl: async () => fakeRes(404, '{"error":"not-found"}'),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], nfDeps)).toBe(1)
  expect(notFound.errs.join('\n')).toContain('404')
  expect(notFound.errs.join('\n')).not.toContain('not-found') // 不回显响应体

  const garbage = ctx({})
  const gDeps = Object.assign({}, garbage.deps, {
    readRpcFile: () => RPC_OK,
    fetchImpl: async () => fakeRes(200, '{不是 JSON'),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], gDeps)).toBe(1)
  expect(garbage.errs.join('\n')).toContain('不是合法 JSON')
  expect(garbage.errs.join('\n')).not.toContain('不是 JSON') // 原始体不回显（消息里只说形状问题）

  const weird = ctx({})
  const wDeps = Object.assign({}, weird.deps, {
    readRpcFile: () => RPC_OK,
    fetchImpl: async () => fakeRes(200, JSON.stringify({ hello: 'world' })),
  })
  expect(await main(['status', '--data-dir', '/tmp/whatever'], wDeps)).toBe(1)
  expect(weird.errs.join('\n')).toContain('形状')
})

it('status 响应体阶段的超时也有界（Important 1）：头部秒回、body 永不完成 → 计时预算压到 text() 落地才解除，掐断退 1 报「超时」', async () => {
  const c = ctx({})
  const deps = Object.assign({}, c.deps, {
    readRpcFile: () => RPC_OK,
    statusTimeoutMs: 20,
    fetchImpl: (url, init) =>
      Promise.resolve({
        status: 200, // 头部这侧「赢了」——旧实现此刻已 clearTimeout，body 阶段再无预算约束
        text: () =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
            })
          }),
      }),
  })
  const t0 = Date.now()
  expect(await main(['status', '--data-dir', '/tmp/whatever'], deps)).toBe(1)
  expect(c.errs.join('\n')).toContain('超时')
  expect(Date.now() - t0).toBeLessThan(2000) // 修复前：这条永远等不到收口（vitest 超时=本用例天然能红）
})

it('status 真回环端到端（rpc.js 起真服务）：数据年龄、粘滞 restartRequired 置顶、孤儿 id+数量+正确清除路径、输出零 secret 零 apiKey', async () => {
  const dir = freshDir()
  const base = 1730000000000
  const snap = {
    meta: {
      deviceId: null,
      name: 'lab-vm',
      uptimeMs: 123000,
      globalHourCount: null,
      restartRequired: true, // R26/R28/R31：粘滞位「不可能看漏」的验收面
      generatedAt: base,
    },
    bots: [],
  }
  const { startControlServer } = await import('../rpc.js') // 延迟加载：见文件头注意
  const handle = await startControlServer({ dir, snapshot: () => snap, pid: 4242, startedAt: base })
  try {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        bots: [],
        lifetime: {},
        orphans: { ghosta: { nick: 'ANON-AAAA', lifetime: { promptTokens: 1, completionTokens: 2 } }, ghostb: { nick: null, lifetime: null } },
      }),
    )
    const out = []
    const errs = []
    const code = await main(['status', '--data-dir', dir], {
      print: (l) => out.push(String(l)),
      printErr: (l) => errs.push(String(l)),
      now: () => base + 2000,
    })
    expect(code).toBe(0)
    expect(errs.join('\n')).toBe('')
    const joined = out.join('\n')
    // Q12 新鲜度口径：报「N 秒前」，不宣称与实时相等
    expect(joined).toContain('2 秒前')
    expect(joined).toContain('≤5')
    // R31：置顶显眼——前 3 行内必须出现（不许埋在表格底下）
    expect(out.slice(0, 3).join('\n')).toContain('restartRequired')
    expect(joined).toContain('重启')
    // R28/R30 形状如实渲染：deviceId null 直说、globalHourCount null 说「未配置」而非 0
    expect(joined).toContain('null')
    expect(joined).toContain('未配置')
    // Task 5 parked：孤儿只读暴露 + 唯一正确清除路径（先停 daemon），不许让人手改活文件
    expect(joined).toContain('2 个')
    expect(joined).toContain('ghosta')
    expect(joined).toContain('ghostb')
    expect(joined).toContain('先停')
    expect(joined).toContain('复活')
    // A1/A7：secret 与 key 材料不进输出
    expect(joined).not.toContain(handle.secret)
    expect(joined).not.toContain('apiKey')
  } finally {
    await handle.close()
  }
})

it('status 真回环·401 实弹：rpc.json 的 secret 与在场 daemon 不一致 → 退 1，文案点破 secret 不匹配（不混「未在运行」）', async () => {
  const dir = freshDir()
  const base = 1730000000000
  const snap = {
    meta: { deviceId: null, name: 'lab-vm', uptimeMs: 1000, globalHourCount: 7, restartRequired: false, generatedAt: base },
    bots: [],
  }
  const { startControlServer } = await import('../rpc.js') // 延迟加载：见文件头注意
  const handle = await startControlServer({ dir, snapshot: () => snap })
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'rpc.json'), 'utf8'))
    doc.secret = 'cd'.repeat(16) // 模拟「读着旧门牌、daemon 已换新 secret」
    fs.writeFileSync(path.join(dir, 'rpc.json'), JSON.stringify(doc) + '\n')
    const out = []
    const errs = []
    const code = await main(['status', '--data-dir', dir], {
      print: (l) => out.push(String(l)),
      printErr: (l) => errs.push(String(l)),
      now: () => base + 1000,
    })
    expect(code).toBe(1)
    const line = errs.join('\n')
    expect(line).toContain('401')
    expect(line).toContain('secret')
    expect(line).not.toContain('未在运行')
    expect(out.join('\n')).not.toContain(doc.secret)
    expect(out.join('\n')).not.toContain(handle.secret)
  } finally {
    await handle.close()
    // close 的账本对账会认不下被改写过的门牌 → 手动收尾，测试目录仍被 afterAll 兜底
    fs.rmSync(path.join(dir, 'rpc.json'), { force: true })
  }
})

function joinedOf(c) {
  return c.out.concat(c.errs).join('\n')
}
