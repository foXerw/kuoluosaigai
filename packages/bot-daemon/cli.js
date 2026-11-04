// Task 9：`saigai-bot` CLI——run/validate/doctor 的前门（§8.2）。
//
// —— 本文件只做一件事：把 Task 4-8 的部件按钉死的顺序接成程序 ——
// 校验归 config.js、锁归 lock.js、调和归 host.js/converge.js、时序归 watch.js——
// 这里**不实现任何业务语义**，只有装配、顺序与出口。`main(argv, deps) -> Promise<number>`
// 返回退出码（bin 里绝不用顶层 await，见裁定与 eslint 约束）。
//
// —— run 的启动序列（brief Step 4 钉死，顺序即语义）——
// ① 解析参数（默认路径：数据目录 os.homedir()/.config/saigai-bot，配置文件 saigai-bot.config.js）
// ② loadConfig + validateConfig —— 配置非法拒起（退 1）：带着坏配置起 bot 等于裸奔
// ③ acquireLock —— A5：绝不静默、绝不双跑；被占退 3（**不建任何后续部件**）
// ④ createFileStateStore + createDaemonHost —— 锁没到手之前不碰盘上任何部件（顺序③先于此）
// ⑤ host.boot() —— deck 构造与 startBot 同一动作（Task 7 一体化），失败释放锁退 1
// ⑥ 起 watcher（onSettle → host.converge）；`--once` 则跳过 watcher，立即做一次空 diff
//    收敛后按关停序退 0（CI/调试路径，不留任何句柄——Task 8 的 stop 纪律在此兑现）
//
// —— 关停顺序（SIGTERM/SIGINT，钉死）——
// watcher.stop → host.shutdown → lockHandle.release（R21：句柄式，没有 releaseLock）。
// 三步各自 try/catch：一步炸不许连累后两步——锁留在盘上下次会被判陈旧接管，
// 但 bot 半死的进程活着才是事故。幂等：连击只关停一次。
//
// —— 锁被占的两条文案（R21 + Task 6 parked Minor③）——
// holder 可能是 {pid:null, startedAt:null}（重试预算耗尽/锁内容不可读）。直接印
// holder.pid 会把 `null` 甩在输出里迷惑操作者——两条文案分开，**双双退 3、绝不静默**。
//
// —— Task 8 concern #4 的接线层短路 ——
// watcher 启动头两轮会把同一份配置 settle 一次（空 diff converge）。不改
// createConfigWatcher 的签名（独立可测性），而在 onSettle 里比对**上一次结算的指纹**：
// 相同就返回一份全空 Report 短路掉 host.converge——watcher 的日志照常出声（真话：
// 确实没有 bot 变化），一次纯函数 diff 都不必白跑。镜像 watcher 自己的 settledFp
// 语义（先记账再收敛），所以 converge 抛错时也不会出现「以为短路了其实没结算」的错位。
//
// —— A1/A3 与 §8.2 排除项 ——
// 任何 print/logger 调用都不带 apiKey（validateConfig 的 errors 已证不回显值）；
// 用法文本只讲 run/validate/doctor——pair/revoke 是 P3 能力，**连提都不提**
// （§8.2 的理由：不在文档里承诺未实现的东西）。
//
// —— 可注入面（测试零真网零 spawn 的代价来源）——
// load/acquireLock/createStore/createHost/createWatcher/onSignal/homedir/now/sleep/
// fetchImpl/WebSocketImpl/createRunner/print/printErr/logger 全是 deps 参数，缺省接真件。
// logger 缺省是**不会抛**的极简 console 包装（Task 1 的 sink 免疫教训；真结构化日志归 Task 11）。

import os from 'node:os'
import path from 'node:path'

import { loadConfig, validateConfig, ConfigLoadError } from './config.js'
import { acquireLock } from './lock.js'
import { createFileStateStore } from './state.js'
import { createDaemonHost } from './host.js'
import { createConfigWatcher } from './watch.js'
import { runDoctor } from './doctor.js'

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2
export const EXIT_LOCK_HELD = 3

const DEFAULT_DATA_SUBDIR = path.join('.config', 'saigai-bot')
const DEFAULT_CONFIG_FILE = 'saigai-bot.config.js'

const USAGE = [
  'saigai-bot — 聊天室 bot daemon CLI（P1）',
  '',
  '用法：',
  '  saigai-bot run [--config <路径>] [--data-dir <路径>] [--once]',
  '      前台运行 daemon；--once 只跑一轮（启动+一次收敛+关停）即退，供调试与 CI。',
  '  saigai-bot validate <配置文件>',
  '      不连网，只做加载与纯数据校验（编辑器/CI 用）。',
  '  saigai-bot doctor [--config <路径>] [--data-dir <路径>]',
  '      环境体检，逐项打印 OK/FAIL：Node 版本、原生 WebSocket、配置校验、',
  '      provider 出网实测（§5 前提）、serverUrl WS 可达、本地时钟、数据目录可写。',
  '',
  '默认数据目录 ~/.config/saigai-bot/（锁与 state.json 所在），默认配置 <数据目录>/saigai-bot.config.js。',
  '退出码：0 正常；1 校验/体检/运行失败；2 用法错误；3 单实例锁被占用。',
].join('\n')

// —— 不会抛的 console 包装（Task 11 造真身之前顶用；EPIPE/磁盘满不许带走进程）——
function safeConsoleLogger() {
  function wrap(method) {
    return (msg, fields) => {
      try {
        const fn = typeof console[method] === 'function' ? console[method] : console.log
        if (fields === undefined) fn.call(console, msg)
        else fn.call(console, msg, fields)
      } catch (e) {
        /* sink 免疫：吞。日志器死了不许陪葬 daemon（host.js 同款教训）。 */
      }
    }
  }
  return { info: wrap('log'), warn: wrap('warn'), error: wrap('error') }
}

function safePrint(fn) {
  return (line) => {
    try {
      fn(String(line))
    } catch (e) {
      /* 输出面不许炸掉命令本体 */
    }
  }
}

function withDefaults(deps) {
  const d = deps || {}
  return {
    print: d.print || safePrint((line) => console.log(line)),
    printErr: d.printErr || safePrint((line) => console.error(line)),
    logger: d.logger || safeConsoleLogger(),
    load: d.load || ((p) => loadConfig(p)),
    acquireLock: d.acquireLock || acquireLock,
    createStore: d.createStore || createFileStateStore,
    createHost: d.createHost || createDaemonHost,
    createWatcher: d.createWatcher || createConfigWatcher,
    onSignal:
      d.onSignal ||
      ((name, cb) => {
        process.on(name, cb)
        return () => {
          process.off(name, cb)
        }
      }),
    homedir: d.homedir || (() => os.homedir()),
    now: d.now, // 缺省交给下游（host/doctor 各有 Date.now 默认参）
    sleep: d.sleep,
    fetchImpl: d.fetchImpl,
    WebSocketImpl: d.WebSocketImpl,
    createRunner: d.createRunner,
  }
}

function fingerprintOf(cfg) {
  // 与 watch.js 同款判据：validateConfig 产物定案键序，JSON.stringify 即指纹。
  try {
    return JSON.stringify(cfg)
  } catch (e) {
    return null
  }
}

// 短路时交给 watcher 的假 Report：字段与 host.converge 的 Report 同形（R28 日志口径），
// 内容是真话——确实什么都没变。
function noopReport(cfg) {
  return {
    added: [],
    removed: [],
    changed: [],
    unchanged: cfg && Array.isArray(cfg.bots) ? cfg.bots.map((b) => b.id) : [],
    limitsChanged: false,
    serverUrlChanged: false,
    providerChanged: false,
    restartRequired: false,
    needsBotRestart: false,
  }
}

// —— 参数解析（零依赖手写）——
function parseOptions(rest) {
  const opts = { once: false, config: null, dataDir: null, positional: [] }
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--once') {
      opts.once = true
    } else if (a === '--config' || a === '--data-dir') {
      const v = rest[i + 1]
      if (typeof v !== 'string' || v === '') return { error: '缺少参数值：' + a + ' 后面要跟路径' }
      if (a === '--config') opts.config = v
      else opts.dataDir = v
      i += 1
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a.indexOf('-') === 0) {
      return { error: '未知选项：' + a }
    } else {
      opts.positional.push(a)
    }
  }
  return opts
}

function resolvePaths(opts, d) {
  const dataDir = opts.dataDir || path.join(d.homedir(), DEFAULT_DATA_SUBDIR)
  const configPath = opts.config || path.join(dataDir, DEFAULT_CONFIG_FILE)
  return { dataDir, configPath }
}

function printConfigFailure(d, err) {
  if (err instanceof ConfigLoadError) {
    // kind 如实透传（Task 4 parked Minor②：判读跟着**实现**走，不跟旧注释走）。
    d.printErr('FAIL: 配置读取失败（' + err.kind + '）：' + err.message)
    return
  }
  d.printErr('FAIL: 配置加载抛出未预期异常：' + (err && err.name ? err.name + '：' : '') + (err && err.message ? err.message : String(err)))
}

function printValidationFailure(d, res, sink) {
  for (const line of res.errors) sink(line)
  sink('FAIL: 配置非法（' + res.errors.length + ' 条）')
}

// —— validate：不连网（§8.2），加载 + 纯数据校验 ——
async function validateCommand(rest, d) {
  const opts = parseOptions(rest)
  if (opts.error || opts.help) {
    if (opts.error) d.printErr('用法错误：' + opts.error)
    d.print(USAGE)
    return opts.error ? EXIT_USAGE : EXIT_OK
  }
  if (opts.positional.length !== 1) {
    d.printErr('用法错误：validate 需要且只需要一个配置文件参数')
    d.print(USAGE)
    return EXIT_USAGE
  }
  let raw
  try {
    raw = await d.load(opts.positional[0])
  } catch (err) {
    printConfigFailure(d, err)
    return EXIT_FAIL
  }
  const res = validateConfig(raw)
  if (!res.ok) {
    printValidationFailure(d, res, d.print) // brief：stdout 列出 errors（编辑器/CI 吃这条通道）
    return EXIT_FAIL
  }
  d.print('OK: 配置合法（bots: ' + res.cfg.bots.length + '）')
  return EXIT_OK
}

// —— doctor ——
async function doctorCommand(rest, d) {
  const opts = parseOptions(rest)
  if (opts.error || opts.help) {
    if (opts.error) d.printErr('用法错误：' + opts.error)
    d.print(USAGE)
    return opts.error ? EXIT_USAGE : EXIT_OK
  }
  if (opts.positional.length > 0) {
    d.printErr('用法错误：doctor 不接受位置参数（配置用 --config 指定）')
    d.print(USAGE)
    return EXIT_USAGE
  }
  const { dataDir, configPath } = resolvePaths(opts, d)
  return runDoctor({
    configPath,
    dataDir,
    print: d.print,
    load: d.load,
    fetchImpl: d.fetchImpl,
    WebSocketImpl: d.WebSocketImpl,
    now: d.now,
    sleep: d.sleep,
  })
}

// —— run：六步序列（文件头钉死）——
async function runCommand(rest, d) {
  // ① 解析参数
  const opts = parseOptions(rest)
  if (opts.error || opts.help) {
    if (opts.error) d.printErr('用法错误：' + opts.error)
    d.print(USAGE)
    return opts.error ? EXIT_USAGE : EXIT_OK
  }
  if (opts.positional.length > 0) {
    d.printErr('用法错误：run 不接受位置参数')
    d.print(USAGE)
    return EXIT_USAGE
  }
  const { dataDir, configPath } = resolvePaths(opts, d)

  // ② loadConfig + validateConfig——拒则退 1，锁都不碰
  let raw
  try {
    raw = await d.load(configPath)
  } catch (err) {
    printConfigFailure(d, err)
    return EXIT_FAIL
  }
  const vres = validateConfig(raw)
  if (!vres.ok) {
    printValidationFailure(d, vres, d.printErr)
    return EXIT_FAIL
  }
  const cfg = vres.cfg

  // ③ acquireLock——A5：两条文案、双双退 3、拿不到锁绝不建后续部件。
  // R21：成功面是**句柄**（{ok:true, tookOver, release()}），不存在 releaseLock。
  let lock
  try {
    lock = d.acquireLock({ dir: dataDir })
  } catch (err) {
    // 锁检查自身炸（EACCES/EROFS…）是真故障，不是「无锁」：出声退 1，绝不静默续跑。
    d.printErr('FAIL: 单实例锁检查失败（' + ((err && (err.code || err.name)) || '未知原因') + '）：数据目录不可用？' + dataDir)
    return EXIT_FAIL
  }
  if (!lock || !lock.ok) {
    const holder = lock && lock.holder ? lock.holder : { pid: null }
    if (holder.pid !== null && holder.pid !== undefined) {
      d.printErr(
        '已有另一个 saigai-bot daemon 在运行：已被 PID ' + holder.pid + ' 持有（最后一次观察到的持有者，可能已不存活）。' +
          '数据目录：' + dataDir + '——确认该进程不存在后删除锁文件重试，或跑 saigai-bot doctor 复查。绝不双跑。',
      )
    } else {
      d.printErr(
        '已有另一个 saigai-bot daemon 在运行：持有者未知（锁文件在场但读不出合法 PID/启动时间，或锁在重试预算内反复易主）。' +
          '数据目录：' + dataDir + '——请人工检查数据目录下的锁文件后重试。绝不双跑。',
      )
    }
    return EXIT_LOCK_HELD
  }
  if (lock.tookOver) {
    d.logger.warn('接管陈旧锁：上一实例未干净退出（数据目录 ' + dataDir + '），已清理陈旧锁文件并接管')
  }

  // 关停三部曲（顺序钉死）：watcher.stop → host.shutdown → lock release。
  // 各步独立 try/catch：一步炸不许连累后一步；每步都出声。
  function shutdownParts(watcher, host) {
    const problems = []
    if (watcher) {
      try {
        watcher.stop()
      } catch (e) {
        problems.push('watcher.stop：' + (e && e.message ? e.message : String(e)))
      }
    }
    try {
      host.shutdown()
    } catch (e) {
      problems.push('host.shutdown：' + (e && e.message ? e.message : String(e)))
    }
    try {
      lock.release()
    } catch (e) {
      problems.push('lock.release：' + (e && e.message ? e.message : String(e)))
    }
    for (const p of problems) d.printErr('FAIL: 关停步骤失败（' + p + '）——继续执行其余步骤')
    return problems.length === 0
  }

  // ④ createFileStateStore + createDaemonHost
  const store = d.createStore({ dir: dataDir })
  const host = d.createHost({
    cfg,
    store,
    logger: d.logger,
    now: d.now,
    WebSocketImpl: d.WebSocketImpl,
    sleep: d.sleep,
    createRunner: d.createRunner,
  })

  // ⑤ boot（失败：释放锁退 1——锁留在别人手里是事故，留在自己手里不留）
  try {
    await host.boot()
  } catch (err) {
    try {
      lock.release()
    } catch (e) {
      /* release 内部已兜底，这里只防自造句柄 */
    }
    d.printErr('FAIL: daemon 启动失败：' + (err && err.message ? err.message : String(err)))
    return EXIT_FAIL
  }
  d.logger.info('daemon 已启动（config ' + configPath + '，data-dir ' + dataDir + '）')

  // ⑥ watcher 或 --once
  if (opts.once) {
    // CI/调试路径：跑一轮（boot + 一次收敛）就按关停序退出，**不建 watcher**——
    // 没有 interval 句柄可留，Task 8 的句柄纪律在这里兑现成「进程能自然退出」。
    let code = EXIT_OK
    try {
      await host.converge(cfg)
    } catch (err) {
      d.printErr('FAIL: --once 收敛失败：' + (err && err.message ? err.message : String(err)))
      code = EXIT_FAIL
    }
    if (!shutdownParts(null, host)) code = EXIT_FAIL
    if (code === EXIT_OK) d.logger.info('daemon 已完成一轮（--once），干净退出')
    return code
  }

  let settledFp = fingerprintOf(cfg) // 镜像 watcher.settledFp：先记账，再收敛
  const watcher = d.createWatcher({
    load: () => d.load(configPath), // 与启动读同一份文件；watcher 每轮真重导入（R27 类缺陷防线）
    onSettle: async (nextCfg) => {
      const fp = fingerprintOf(nextCfg)
      if (fp !== null && fp === settledFp) return noopReport(nextCfg) // 启动期空 diff settle 的接线层短路
      settledFp = fp
      return host.converge(nextCfg)
    },
    logger: d.logger,
  })

  return await new Promise((resolve) => {
    let offSignal = []
    let done = false
    const stopAll = () => {
      if (done) return // 连击幂等：只关停一次，release 不双跑
      done = true
      const clean = shutdownParts(watcher, host)
      d.logger.info(clean ? 'daemon 已优雅停止' : 'daemon 停止流程有步骤失败（详见上方 FAIL 行）')
      for (const off of offSignal) {
        try {
          off()
        } catch (e) {
          /* 摘不掉也不改变退出码 */
        }
      }
      resolve(EXIT_OK)
    }
    offSignal = [d.onSignal('SIGTERM', stopAll), d.onSignal('SIGINT', stopAll)]
    watcher.start()
  })
}

/**
 * CLI 主入口：返回退出码（bin 不用顶层 await）。
 * @param {string[]} argv process.argv.slice(2)
 * @param {object} [deps] 注入面（见文件头「可注入面」）
 * @returns {Promise<number>} 0/1/2/3（EXIT_*）
 */
export async function main(argv, deps) {
  const d = withDefaults(deps || {})
  const args = Array.isArray(argv) ? argv : []
  const cmd = args[0]
  const rest = args.slice(1)
  if (cmd === 'run') return runCommand(rest, d)
  if (cmd === 'validate') return validateCommand(rest, d)
  if (cmd === 'doctor') return doctorCommand(rest, d)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    d.print(USAGE)
    return EXIT_OK
  }
  // 未知/缺失子命令：用法上 stdout、原因上 stderr，退 2（§8.2 用法面只提三命令）。
  d.printErr(cmd ? '未知子命令：' + cmd : '缺少子命令')
  d.print(USAGE)
  return EXIT_USAGE
}
