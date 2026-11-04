// @vitest-environment node
// Task 9：CLI 组装测试。优先单测注入依赖的 main(argv)（brief 明示），真组装只上
// --once 一条（假 runner、假 WS 构造即抛、tmpdir 态目录），spawn 冒烟只留一条且带硬超时。
// 钉死：启动六步顺序、R21 句柄式 release（无 releaseLock）、holder 两文案 + 双双退 3 非零
// （A5 不静默）、退出码 0/1/2/3、关停顺序 watcher→host→lock、--once 零残留句柄、
// Task 8 concern#4 的接线层短路、§8.2 help 文本不提 pair/revoke、A1 key 不落输出。
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateConfig, ConfigLoadError } from '../config.js'
import { main } from '../cli.js'

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

it('run --once：boot → converge → host.shutdown → lock.release，退 0，watcher 完全不建', async () => {
  const c = ctx({})
  const code = await main(['run', '--once', '--data-dir', '/tmp/whatever'], c.deps)
  expect(code).toBe(0)
  expect(c.order).toEqual(['acquireLock', 'createStore', 'createHost', 'host.boot', 'host.converge', 'host.shutdown', 'lock.release'])
  expect(c.order).not.toContain('createWatcher')
  expect(c.order).not.toContain('watcher.start')
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

it('run 常驻：SIGINT → watcher.stop → host.shutdown → lock.release（钉死顺序），监听器随退出摘除', async () => {
  const c = ctx({})
  const p = main(['run', '--data-dir', '/tmp/whatever'], c.deps)
  await until(() => c.signals.SIGINT && c.signals.SIGTERM)
  expect(c.order).toEqual(['acquireLock', 'createStore', 'createHost', 'host.boot', 'createWatcher', 'watcher.start'])
  c.signals.SIGINT()
  expect(await p).toBe(0)
  expect(c.order.slice(6)).toEqual(['watcher.stop', 'host.shutdown', 'lock.release'])
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
    child.on('exit', (exitCode) => {
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

function joinedOf(c) {
  return c.out.concat(c.errs).join('\n')
}
