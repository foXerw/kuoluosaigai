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
// ⑤.5 startControlServer（Task 10/Q12）—— boot 成功后才起 127.0.0.1 只读控制口、落
//     rpc.json{port,secret,pid,startedAt}。起不来只**大声 FAIL 不拦 daemon**：bot 面是业务、
//     观测面是仪表盘，仪表盘炸不许把车停下（A5 的「不静默」由 printErr 兑现）。`--once`
//     整步跳过——那条路的承诺是「不留任何句柄」，字面成立。
// ⑥ 起 watcher（onSettle → host.converge）；`--once` 则跳过 watcher，立即做一次空 diff
//    收敛后按关停序退 0（CI/调试路径，不留任何句柄——Task 8 的 stop 纪律在此兑现）
//
// —— 关停顺序（SIGTERM/SIGINT，钉死）——
// watcher.stop → control.close → host.shutdown → lockHandle.release（R21：句柄式，没有 releaseLock）。
// Task 10 的 control.close 插在 watcher.stop 之后、host.shutdown 之前：先关「status 的读数门」
// 再拆店，关停竞态里 status 只会得到诚实的「未在运行」。三步原序的相对次序不变。
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
// 用法文本只讲 run/validate/doctor/status（status 是 P1 已实现能力，Task 10）——
// pair/revoke 是 P3 能力，**连提都不提**（§8.2 的理由：不在文档里承诺未实现的东西）。
//
// —— status（Task 10/Q12）：纯客户端，零业务语义 ——
// 读 rpc.json → 带 secret 对 127.0.0.1 发**一次** GET /status（AbortController 限时自断，
// 陈旧门牌不许挂死 CLI）→ 只读渲染。失败分型文案互不相同（「未在运行」/「陈旧或读不出」/
// 「连不上」/「超时」/「401 secret」），操作者靠文案就能定位是哪件事坏了，不靠猜退出码。
// 渲染面三条硬要求：①粘滞 restartRequired 打在第一线（R26/R28/R31 的「不可能看漏」
// 就以这份输出验收，不许埋进表格底下）；②数据年龄按 meta.generatedAt 如实报「N 秒前」
// （Q12 口径 ≤5s，不宣称与实时相等）；③孤儿只读暴露 id+数量，并写清**唯一正确的清除
// 路径（先停 daemon 再动 state.json）**——运行中手改会被写回复活（Task 5 parked），
// 不能让操作者白忙。输出里零 secret、零 key 材料、零响应体回显。
//
// —— 可注入面（测试零真网零 spawn 的代价来源）——
// load/acquireLock/createStore/createHost/createWatcher/onSignal/homedir/now/sleep/
// fetchImpl/WebSocketImpl/createRunner/startControlServer/readRpcFile/statusTimeoutMs/
// print/printErr/logger 全是 deps 参数，缺省接真件。
// logger 缺省是**不会抛**的极简 console 包装（Task 1 的 sink 免疫教训；真结构化日志归 Task 11）。

import os from 'node:os'
import path from 'node:path'

import { loadConfig, validateConfig, ConfigLoadError } from './config.js'
import { acquireLock } from './lock.js'
import { createFileStateStore } from './state.js'
import { createDaemonHost } from './host.js'
import { createConfigWatcher } from './watch.js'
import { runDoctor } from './doctor.js'
import { SECRET_HEADER, readRpcFile, startControlServer } from './rpc.js'

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2
export const EXIT_LOCK_HELD = 3
// R34（审查轮 1 裁定）：关停步骤炸 ≠ 干净停止——host.shutdown 炸可能意味着 B12 的
// lifetime 冲刷没落盘（成本账目丢失）。systemd Restart=always 下退 0 会谎报「正常停止」，
// 所以常驻与 --once 两路统一退 4；--once 里若 converge 已炸（1），1 优先不被 4 覆盖。
// Task 12 的 README/unit 要写明这个码。
export const EXIT_SHUTDOWN_FAILED = 4

const DEFAULT_DATA_SUBDIR = path.join('.config', 'saigai-bot')
const DEFAULT_CONFIG_FILE = 'saigai-bot.config.js'
// status 的请求预算：控制口就在同一台机器的回环上，秒级不响应就是挂了/极忙——
// 有界失败（AbortController 限时自断）好过让操作者的终端卡在一张陈旧门牌上（Task 9 句柄教训同款）。
const STATUS_TIMEOUT_MS = 5000

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
  '  saigai-bot status [--data-dir <路径>]',
  '      查询运行中的 daemon：读数据目录 rpc.json，带其中 secret 向 127.0.0.1 发一次',
  '      只读 GET /status 并渲染——数据年龄（Q12 口径 ≤5s）、粘滞 restartRequired（置顶',
  '      大声提醒，重启 daemon 才消失）、各 bot 状态与账目、孤儿身份清单（只读）。',
  '      真防线是「只绑回环 + secret」；rpc.json 的 0600 文件位在 Windows 上**只是',
  '      尽力而为、不是防线**。没运行/陈旧/连不上/超时/401 → 退 1，各配独立文案。',
  '',
  '默认数据目录 ~/.config/saigai-bot/（锁与 state.json 所在），默认配置 <数据目录>/saigai-bot.config.js。',
  '退出码：0 正常；1 校验/体检/运行失败，或 status 查询不到 daemon；2 用法错误；',
  '        3 单实例锁被占用；4 关停有步骤失败（state.json 冲刷可能未落盘）。',
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
    startControlServer: d.startControlServer || startControlServer,
    readRpcFile: d.readRpcFile || readRpcFile,
    statusTimeoutMs: d.statusTimeoutMs,
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

  let control = null // Task 10：⑤.5 起成什么就是什么；关停四步曲按在场性拆（--once 恒 null）

  // 关停四步曲（相对序钉死）：watcher.stop → control.close → host.shutdown → lock release。
  // 各步独立 try/catch：一步炸不许连累后一步；每步都出声。
  async function shutdownParts(watcher, host) {
    const problems = []
    if (watcher) {
      try {
        watcher.stop()
      } catch (e) {
        problems.push('watcher.stop：' + (e && e.message ? e.message : String(e)))
      }
    }
    if (control) {
      // close() 自带摘牌（删自家 rpc.json）+ 掐连接；炸了也只是门牌可能残留——
      // status 侧对死端口有界失败，不算连累，但照旧进 problems（R34）。
      try {
        await control.close()
      } catch (e) {
        problems.push('control.close：' + (e && e.message ? e.message : String(e)))
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

  // ⑤.5 控制服务（Task 10/Q12）：boot 成功之后才有「可读的 host」可暴露——
  // startControlServer 内部 listen(0, 回环) 成功后才落 rpc.json（见 rpc.js 文件头）。
  // 失败方向：观测面炸不拖垮 bot 面——printErr 大声 FAIL（A5 不静默），daemon 照常跑。
  // --once 跳过本步（见下）：调试/CI 路径的承诺是零残留句柄，不起 just-in-time 的门牌。
  if (!opts.once) {
    try {
      control = await d.startControlServer({ snapshot: () => host.snapshot(), dir: dataDir })
      d.logger.info('控制服务已就绪 127.0.0.1:' + control.port + '（rpc.json 已落 ' + dataDir + '；secret 只在那份文件里，不进日志）')
    } catch (err) {
      control = null
      d.printErr('FAIL: 控制服务未能启动（' + (err && err.message ? err.message : String(err)) + '）——daemon 继续运行，但 status 查不到它（观测面故障不拦 bot 面）')
    }
  }

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
    if (!(await shutdownParts(null, host)) && code === EXIT_OK) code = EXIT_SHUTDOWN_FAILED // R34：1 优先于 4
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
    const stopAll = async () => {
      if (done) return // 连击幂等：只关停一次，release 不双跑
      done = true
      const clean = await shutdownParts(watcher, host) // control.close 在 watcher.stop 与 host.shutdown 之间（摘牌）
      d.logger.info(clean ? 'daemon 已优雅停止' : 'daemon 停止流程有步骤失败（详见上方 FAIL 行）——这不是干净停止（R34）')
      for (const off of offSignal) {
        try {
          off()
        } catch (e) {
          /* 摘不掉也不改变退出码 */
        }
      }
      resolve(clean ? EXIT_OK : EXIT_SHUTDOWN_FAILED) // R34：关停步骤炸 → 4
    }
    offSignal = [d.onSignal('SIGTERM', stopAll), d.onSignal('SIGINT', stopAll)]
    watcher.start()
  })
}

// —— status 的渲染面（纯格式化；判据全来自 snapshot()/state.json 的盘上事实）——
function renderStatus(d, snap, dataDir) {
  const meta = snap && typeof snap === 'object' && snap.meta && typeof snap.meta === 'object' ? snap.meta : null
  const bots = snap && Array.isArray(snap.bots) ? snap.bots : null
  if (!meta || !bots) {
    d.printErr('FAIL: 控制口返回 200 但形状不是 {meta, bots}（版本错配？）——渲染面不做猜测，不输出半张表')
    return false
  }
  // R26/R28/R31：粘滞位永远占第一行——「不可能看漏」这条验收写的就是 status 的输出面。
  if (meta.restartRequired) {
    d.print('!! restartRequired（粘滞位）：limits/serverUrl 一类变更要**重启 daemon 进程**才生效——当前进程仍在旧闸与旧地址上运行。')
    d.print('!! 处置：重启本进程（systemd 托管就 systemctl restart）；此提示在进程重启前不会消失，也不会被热重载洗掉（R28）。')
  }
  d.print('saigai-bot status —— daemon「' + (typeof meta.name === 'string' ? meta.name : '(无名)') + '」（数据目录 ' + dataDir + '）')
  // Q12 新鲜度口径：报「数据为 N 秒前」，不宣称与实时相等；>5s 就如实说超窗。
  const nowFn = d.now || Date.now
  const ageSec = Number.isFinite(meta.generatedAt) ? Math.max(0, Math.floor((nowFn() - meta.generatedAt) / 1000)) : null
  if (ageSec === null) {
    d.print('数据时点：未知（快照没带可解析的 generatedAt——渲染面不猜）')
  } else if (ageSec > 5) {
    d.print('数据为 ' + ageSec + ' 秒前——已超过 ≤5s 新鲜度口径（控制面按请求实时取数，不该这么旧：怀疑时钟跳变或 daemon 卡滞）')
  } else {
    d.print('数据为 ' + ageSec + ' 秒前（Q12 新鲜度口径：≤5s 视为新鲜）')
  }
  d.print('deviceId：' + (meta.deviceId === null || meta.deviceId === undefined ? 'null（P1 事实：设备令牌尚未铸造，非配对遗漏；字段在场≠已接线，R30）' : String(meta.deviceId)))
  d.print('进程运行时长：' + (Number.isFinite(meta.uptimeMs) ? Math.floor(meta.uptimeMs / 1000) + ' 秒' : '未知'))
  d.print('全局小时闸：' + (meta.globalHourCount === null || meta.globalHourCount === undefined ? '未配置（未安装≠未消耗，别读成 0）' : meta.globalHourCount + ' 条/已用（本小时）'))
  d.print('restartRequired：' + (meta.restartRequired ? '有——见顶部 !! 横幅' : '无待进程重启的变更'))
  if (bots.length === 0) {
    d.print('bots：0（deck 空转，daemon 活着）')
  } else {
    d.print('bots：' + bots.length + ' 个（room 列为**有效房**非配置值，R20；nick 是服务器分配的身份）')
    for (const b of bots) {
      const s = b.session || {}
      const lt = b.lifetime || {}
      d.print(
        '  ' +
          b.id +
          ' | ' +
          b.name +
          ' | 房 ' +
          (b.room === null || b.room === undefined ? '?' : b.room) +
          ' | ' +
          (b.status || '?') +
          ' | 昵称 ' +
          (b.nick || '(未定)') +
          ' | 小时计数 ' +
          (Number.isFinite(b.hourCount) ? b.hourCount : '?') +
          ' | 会话 p' +
          (s.promptTokens !== undefined ? s.promptTokens : '?') +
          '/c' +
          (s.completionTokens !== undefined ? s.completionTokens : '?') +
          '/' +
          (s.messages !== undefined ? s.messages : '?') +
          ' 条 | 累计 p' +
          (lt.promptTokens !== undefined ? lt.promptTokens : '?') +
          '/c' +
          (lt.completionTokens !== undefined ? lt.completionTokens : '?'),
      )
    }
  }
  // Task 5 parked（孤儿无 GC + 手删不生效）：只读暴露 + 唯一正确清除路径，说人话。
  let orphans = null
  let orphanErr = null
  try {
    const store = d.createStore({ dir: dataDir })
    orphans = store.readOrphans()
  } catch (e) {
    orphanErr = (e && (e.code || e.name)) || '未知'
  }
  if (orphanErr !== null) {
    d.print('孤儿身份：未能读取 state.json（' + orphanErr + '）——不影响上方读数，如实说不知道')
  } else {
    const ids = Object.keys(orphans || {})
    d.print('孤儿身份（state.orphans，Q2 防误删保留）：' + ids.length + ' 个' + (ids.length > 0 ? ' → ' + ids.join(', ') : ''))
    if (ids.length > 0) {
      d.print('  孤儿条目没有自动 GC；在**运行中的 daemon** 手改 state.json 删不掉它们——适配器按缓存基准重播，下一次写就复活。')
      d.print('  唯一正确的清除路径：先停 daemon → 删除数据目录里的 state.json（等价 removeItem，身份与账目一并抹除）或换新的 --data-dir → 再启动。')
    }
  }
  return true
}

// —— status：连本机 daemon 的控制口（Task 10/Q12）。三态三文案，全退 1；成功退 0 ——
async function statusCommand(rest, d) {
  const opts = parseOptions(rest)
  if (opts.error || opts.help) {
    if (opts.error) d.printErr('用法错误：' + opts.error)
    d.print(USAGE)
    return opts.error ? EXIT_USAGE : EXIT_OK
  }
  if (opts.positional.length > 0) {
    d.printErr('用法错误：status 不接受位置参数（数据目录用 --data-dir 指定）')
    d.print(USAGE)
    return EXIT_USAGE
  }
  if (opts.config !== null) {
    d.printErr('用法错误：status 不读配置文件（--config 对它无意义）——它只查询本机正在运行的 daemon')
    d.print(USAGE)
    return EXIT_USAGE
  }
  const { dataDir } = resolvePaths(opts, d)
  const rpc = d.readRpcFile({ dir: dataDir })
  if (!rpc.ok) {
    // 三条独立文案（派发钉的验收）：「没门牌」/「门牌读不动」/「门牌是陈旧的」。
    if (rpc.why === 'missing') {
      d.printErr('FAIL: ' + rpc.path + ' 不在——daemon 未在运行？（只有 saigai-bot run 会写它、干净关停时拆掉它）')
    } else if (rpc.why === 'unreadable') {
      d.printErr('FAIL: ' + rpc.path + ' 在场但读不出（权限/IO 故障）——daemon 未在运行，或数据目录没指对？')
    } else {
      d.printErr('FAIL: ' + rpc.path + ' 在场但解不出合法 {port,secret,pid,startedAt}——陈旧 rpc.json：daemon 死过一次没来得及摘牌？')
    }
    return EXIT_FAIL
  }
  const fetchImpl = d.fetchImpl || ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = typeof d.statusTimeoutMs === 'number' && d.statusTimeoutMs > 0 ? d.statusTimeoutMs : STATUS_TIMEOUT_MS
  const url = 'http://127.0.0.1:' + rpc.info.port + '/status'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { [SECRET_HEADER]: rpc.info.secret }, signal: controller.signal })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      d.printErr('FAIL: 控制口 127.0.0.1:' + rpc.info.port + ' 请求超时（' + timeoutMs + 'ms 内无响应）——已主动掐断，有界失败不挂死。daemon 卡滞或机器极忙？')
    } else {
      const why = (err && err.cause && err.cause.message) || (err && err.message) || '未知网络错误'
      d.printErr('FAIL: 连不上 127.0.0.1:' + rpc.info.port + '（' + why + '）——陈旧 rpc.json：daemon 已死但没来得及摘牌。重启 daemon 或确认其不存在后删掉 ' + rpc.path)
    }
    return EXIT_FAIL
  } finally {
    clearTimeout(timer) // 超时定时器必清（Task 9 句柄纪律）
  }
  let text
  try {
    text = await res.text() // 非 200 也读完：keep-alive 套接字不许揣着未读 body 走人
  } catch (err) {
    d.printErr('FAIL: 读取控制口响应体失败（' + ((err && (err.code || err.name)) || '未知') + '）')
    return EXIT_FAIL
  }
  if (res.status === 401) {
    // 服务端对「缺 secret」与「错 secret」回**同一响应体**（A7 精神）——这里同样不猜是谁被拒，只说事实。
    d.printErr('FAIL: 401——rpc.json 里的 secret 与在场 daemon 不匹配（多半是 daemon 重启后重铸了 secret、而你手上这份 rpc.json 是旧门牌的缓存）。重新跑一次 status 即可；仍 401 就检查数据目录里是否只有一份 saigai-bot 的 rpc.json')
    return EXIT_FAIL
  }
  if (res.status !== 200) {
    d.printErr('FAIL: 控制口返回 HTTP ' + res.status + '（预期 200）——端口在场但答复不对，这个 rpc.json 指向的未必是 saigai-bot 的控制口')
    return EXIT_FAIL
  }
  let snap
  try {
    snap = JSON.parse(text)
  } catch (e) {
    d.printErr('FAIL: 控制口 200 响应体不是合法 JSON（不回显内容，A3）——端口被别的服务占了？')
    return EXIT_FAIL
  }
  const ok = renderStatus(d, snap, dataDir)
  return ok ? EXIT_OK : EXIT_FAIL
}

/**
 * CLI 主入口：返回退出码（bin 不用顶层 await）。
 * @param {string[]} argv process.argv.slice(2)
 * @param {object} [deps] 注入面（见文件头「可注入面」）
 * @returns {Promise<number>} 0/1/2/3/4（EXIT_*）
 */
export async function main(argv, deps) {
  const d = withDefaults(deps || {})
  const args = Array.isArray(argv) ? argv : []
  const cmd = args[0]
  const rest = args.slice(1)
  if (cmd === 'run') return runCommand(rest, d)
  if (cmd === 'validate') return validateCommand(rest, d)
  if (cmd === 'doctor') return doctorCommand(rest, d)
  if (cmd === 'status') return statusCommand(rest, d)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    d.print(USAGE)
    return EXIT_OK
  }
  // 未知/缺失子命令：用法上 stdout、原因上 stderr，退 2（§8.2 用法面只提三命令）。
  d.printErr(cmd ? '未知子命令：' + cmd : '缺少子命令')
  d.print(USAGE)
  return EXIT_USAGE
}
