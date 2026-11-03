// Task 8：配置热重载 watcher——轮询 + debounce + 坏读不动作（G3/Q10/A4）。
//
// —— 职责边界（brief + 裁定 Q10）——
// watcher 只做三件事：①发现变化（内容指纹变了）；②证明文件**稳定**（编辑器"写临时文件
// 再 rename"是常态，半写状态不是意外——判据：连续两轮轮询指纹相同且读取不抛，第三件事的
// 入场券才兑现）；③只把**解析且校验通过**的配置交出去（onSettle(cfg)）。业务动作
// （diff/addBot/startBot/stopBot）一律归 host.converge——本文件不出现它们，也不 import
// diffConfigs；接线在 Task 9 的 onSettle 回调里做。
//
// —— 坏读不动作（Review Focus #4 / A4）——
// 三类失败与一个合法指令，分流信号是**异常 vs 成功解析+校验**，绝不是内容长度/文件大小：
// - ConfigLoadError（kind 'unreadable' | 'unparsable'，Task 4 的类型化分流）→ 复位稳定追踪，
//   保留上一份好配置，永不 hand-off——半个 bot 都不许因此停掉；
// - 解析成功但 validateConfig !ok（字段错）→ 同路径，不 hand-off；
// - 解析+校验成功且 bots: [] → 这是"我要零 bot"的**合法指令**，照常 hand-off，由 converge
//   去停（操作者真想全停）。
// config.js:59 的 parked 文档缺陷（求值期抛：注释说 unreadable、实现归 unparsable）不影响
// 本文件——两种 kind 走同一条"保留旧配置"路径，分支只看 instanceof 与 kind 在场性，
// 不猜 message 文本，也不按注释假设 kind 的归属。
//
// —— 时序口径（Q10：轮询 1000ms + debounce 500ms；"检测后 ≤2s 完成收敛"）——
// 变更在 poll D 首次读到（检测）→ D+1000 同读，稳定成立 → 起 debounceMs(500) →
// D+1500 hand-off。检测→消费恒 ≤1500ms（debounce 500 < 轮询 1000，定时器必在下一次
// poll 之前开火，hand-off 用的是稳定那一刻的 cfg 快照，不再回头重读）；从真实落盘算
// 最坏 2500ms（变更恰落在 poll 之后），加 converge 本身 ≈3.5s 端到端——计划第 21 行的
// 账。抖动合并：稳定追踪期间任何一次"又变了"的读取都清掉已起的 debounce，中间态永不被
// 交出去（test 钉死"连续 3 个不同中间态只在最后一次稳定 500ms 后回调一次"）。
//
// —— 为什么默认轮询而不是 fs.watch ——
// §14：NAS/SMB 挂载上 fs.watch 失灵是已知事故面；轮询 + 内容指纹（JSON.stringify of
// validateConfig 产物，键序无关的规范化 cfg）不依赖事件，也不依赖 mtime 精度。零新依赖。
//
// —— 缓存击穿重导入（R27 类缺陷的防线）——
// 每轮**重新调用** load()（Task 9 接线 load = () => loadConfig(path)），绝不 memoize
// promise 或结果——apiKey: process.env.KUO_LLM_KEY 靠 re-import 的求值期重读 env，
// 缓存一次就把换 key 洗成"配置没变"、对整条 diff 链永久隐形（watch.test.js 最后一条
// 用真 loadConfig 钉死这条端到端）。指纹吃的是每次 load 的新产物，watcher 不碰 import。
//
// —— R28 ——
// 本文件只消费 onSettle 返回的**本次 converge 的 Report**（日志与 restartRequired 提醒）；
// snapshot().meta.restartRequired 是粘滞位、归 Task 10 的 status 面，两者不许混用，
// watcher 的任何判断都不读 meta。
//
// —— 句柄纪律 ——
// stop() 清掉它创建的全部定时器（轮询 interval + debounce timeout），运行位归零后
// 在途 tick 即便落地也不再挂新 timer、不再 hand-off——24/7 进程与 Task 9 --once 的
// 干净退出都靠这条。onSettle 的 promise 串行成链：converge 永不并发跑（host 的
// current 指针在 await 间被交叉改写就是竞态），链上吞掉的 rejection 只进日志不重抛——
// 热重载失败绝不能反杀 watcher 本身（下一次变更照常收敛）。

import { ConfigLoadError, validateConfig } from './config.js'

function isFn(v) {
  return typeof v === 'function'
}

/**
 * 创建配置热重载 watcher。
 * @param {{
 *   load: () => Promise<unknown>,   // Task 9 接线：() => loadConfig(path)——每轮必须真重导入
 *   onSettle: (cfg: object) => unknown | Promise<unknown>, // 收到 validateConfig 产物；
 *       其返回值（host.converge 的 Report）只用于日志——watcher 从不据它做收敛决策
 *   intervalMs?: number,            // 轮询间隔，默认 1000（Q10）
 *   debounceMs?: number,            // 稳定后的 debounce，默认 500（Q10）
 *   logger?: { info: Function, warn: Function, error: Function }, // 同 host 的注入面，可缺省
 * }} options
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createConfigWatcher({ load, onSettle, intervalMs = 1000, debounceMs = 500, logger } = {}) {
  if (!isFn(load) || !isFn(onSettle)) {
    throw new TypeError('createConfigWatcher：load 与 onSettle 必填且为函数')
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(debounceMs) || debounceMs <= 0) {
    throw new TypeError('createConfigWatcher：intervalMs 与 debounceMs 必须是正数')
  }
  const log = logger || { info() {}, warn() {}, error() {} }

  let running = false
  let pollTimer = null
  let debounceTimer = null
  let prevFp = null // 上一轮"有效且未结算"读取的指纹（稳定追踪）
  let pending = null // { fp, cfg }：稳定成立那一刻的快照，debounce 到点就交出去
  let settledFp = null // 上一次交给 onSettle 的指纹——"上一份好配置"的身份；坏读永不动它
  let lastBadMsg = null // 同一条坏读连续出现只在首次出声（ENOENT 常驻时每 1s warn 就是刷屏）
  let busy = false // 上一轮 load 还悬着：本轮跳过（load 慢于 intervalMs 时不叠轮）
  let queue = Promise.resolve() // hand-off 串行链：converge 并发禁止

  // 日志 sink 免疫（host.js 同款的 Task 1 教训）：logger 抛错不许带走 daemon。
  function safeLog(level, msg, fields) {
    try {
      const fn = log[level]
      if (isFn(fn)) fn.call(log, msg, fields)
    } catch (e) {
      /* 吞。 */
    }
  }

  function clearDebounce() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  // 坏读路径（抛异常 / 解析成功但校验失败共用）：复位稳定追踪、撤掉已起的 debounce，
  // **唯独不动 settledFp**——上一份好配置继续跑，一个 bot 都不许因此停掉。
  function markBad(msg) {
    clearDebounce()
    prevFp = null
    pending = null
    if (msg !== lastBadMsg) {
      lastBadMsg = msg
      safeLog('warn', msg + '：保留上一份好配置，不停任何 bot')
    }
  }

  function fingerprint(cfg) {
    // validateConfig 的 cfg 是定案键序的归一化产物（键序不同 → 同串）；纯数据扫描已在
    // 校验闸外挡掉 bigint/循环，理论到不了 catch——留它只为"指纹失败"也归坏读而非崩溃。
    try {
      return JSON.stringify(cfg)
    } catch (e) {
      return null
    }
  }

  function rlen(a) {
    return Array.isArray(a) ? a.length : 0
  }

  function handoff(p) {
    if (!p) return
    settledFp = p.fp
    prevFp = null
    pending = null
    queue = queue
      .then(() => onSettle(p.cfg))
      .then(
        (report) => {
          // 每次 settle 恰好一条日志（不静默、不刷屏）。R28：这是**本次 converge 的**
          // restartRequired（per-converge），只进日志；snapshot().meta.restartRequired
          // （粘滞位）不在此读、也不由本文件写。接线方若不返回 Report（void）也照样出声。
          if (!report || typeof report !== 'object') {
            safeLog('info', '热重载配置已交付收敛')
            return
          }
          const desc =
            '新增 ' + rlen(report.added) + ' / 移除 ' + rlen(report.removed) + ' / 变更 ' + rlen(report.changed)
          if (report.restartRequired) {
            safeLog('warn', '热重载收敛完成（' + desc + '）：含需**重启 daemon 进程**才兑现的变更（R27①），本次未触碰任何 bot 连接')
          } else if (rlen(report.added) + rlen(report.removed) + rlen(report.changed) > 0) {
            safeLog('info', '热重载收敛完成：' + desc)
          } else {
            safeLog('info', '热重载收敛完成（无 bot 变化）')
          }
        },
        (err) => {
          // converge 抛了：bot 现状不动（host 内部语义归它），watcher 必须活着等下一次变更。
          markBad('热重载收敛调用抛异常（' + (err && err.message ? err.message : String(err)) + '）')
        },
      )
  }

  async function tick() {
    if (!running || busy) return
    busy = true
    try {
      let raw
      try {
        raw = await load()
      } catch (err) {
        if (!running) return
        const kind = err instanceof ConfigLoadError ? String(err.kind) : 'load 抛非 ConfigLoadError'
        const why = err && err.message ? err.message : String(err)
        markBad('配置读取失败（' + kind + '）：' + why)
        return
      }
      if (!running) return
      let res
      try {
        res = validateConfig(raw)
      } catch (e) {
        markBad('配置校验器抛异常（不应发生，validateConfig 是纯函数）：' + (e && e.message ? e.message : String(e)))
        return
      }
      if (!res.ok) {
        // markBad 自带同文首告去重：errors 串没换就不再重复 warn，但状态照常复位。
        markBad('配置非法（' + res.errors.join('; ') + '）')
        return
      }
      lastBadMsg = null // 读到过一次好内容：若再坏，值得重新出声
      const fp = fingerprint(res.cfg)
      if (fp === null) {
        markBad('配置指纹计算失败')
        return
      }
      if (fp === settledFp) {
        // 回到上一份好内容（编辑器写半又撤销 / rename 失败回滚）：静默清账，不重复收敛。
        clearDebounce()
        prevFp = null
        pending = null
        return
      }
      if (prevFp !== null && prevFp === fp) {
        // 连续两轮相同且 ≠ 已结算 → 稳定成立。debounce 500 < 轮询 1000，已起就不重挂，
        // 必在下一次 poll 之前开火；hand-off 用稳定瞬间的 cfg 快照，不再重读。
        pending = { fp, cfg: res.cfg }
        if (debounceTimer === null) {
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            if (!running) return
            handoff(pending)
          }, debounceMs)
        }
      } else {
        // 新的中间态：稳定追踪从头开始，已起的 debounce 作废（抖动合并）。
        prevFp = fp
        pending = null
        clearDebounce()
      }
    } finally {
      busy = false
    }
  }

  function start() {
    if (pollTimer !== null) return // 幂等：重复 start 不叠句柄
    running = true
    prevFp = null
    pending = null
    pollTimer = setInterval(() => {
      tick().catch(() => {
        /* tick 内部全兜底；双保险防 unhandled rejection 杀 24/7 进程 */
      })
    }, intervalMs)
  }

  function stop() {
    running = false
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    clearDebounce()
    prevFp = null
    pending = null
  }

  return { start, stop }
}
