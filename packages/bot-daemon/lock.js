// Task 6：进程级单实例锁（§7.4 / 反目标 A5）。
//
// —— 为什么有这个文件 ——
// 浏览器侧的跨标签互斥归 core 的 lease.js；daemon 的对偶是**进程级**互斥。PVE 场景的具体
// 故障形态：systemd 重启时旧进程未退干净、或用户手动又开了一个——两个 daemon 同时读同一份
// 配置、同房双份发言、双份烧预算、bot 互相搭话。锁住在数据目录里，与 state.json（Task 5）
// 同级同 dir；本模块与 state.js 互不相干（职责分离，不互相导入）。
//
// —— 为什么在 daemon 侧、不进 core ——
// §7.4 落地修正：锁要用 node:fs（O_EXCL/读 PID），node:fs 绝不进 bot-core——webpack 打前端
// bundle 会把它拖进浏览器包、构建必炸。core 侧对应物只有 lease 端口 + createNullLease。
//
// —— 协议（A5：活锁绝不抢）——
// 1. O_EXCL 创建（openSync 'wx'）：「此前不存在」与「现在归我」是同一个原子系统调用；
//    内容 {pid, startedAt} JSON。EEXIST 才去读对方、判活。
// 2. 持有者 PID 存活 → ok:false + holder：不 unlink、不等待重试、不覆写。调用方（Task 9 的
//    run）打印 holder pid 后以退出码 3 退出，交人类处置——**绝不双跑**是这条锁存在的全部理由。
// 3. 陈旧 = 持有者 PID 已死，或内容不可读（坏 JSON / 缺字段——脏文件不永挂daemon）。
//    接管 = unlink 陈旧文件 → 重新 O_EXCL；返回 tookOver:true 让调用方打一条 WARN。
//    startedAt 只做提示与 release 对账，不做同体证明（见下方 PID 复用）。
// 4. 双竞争者竞态：两个进程可能都观察到同一份陈旧锁、都决定接管、都 unlink——只许一个赢。
//    两道防线：①动手 unlink 前先复读锁，内容与我们观察到的不一致 → 说明别人已经行动，
//    回到循环顶部重读+判活；②unlink 后重新 O_EXCL，创建撞 EEXIST（对手抢先写出）→ 同样回到
//    重读+判活。输家只会拿到 ok:false，绝不带着「陈旧锁已被清掉」的错觉继续跑。
//    （tests/lock.test.js 用注入 read/unlink 交错时序把两道防线各钉成一条用例。）
// 5. release() 只删自己的：读盘比对 pid+startedAt；不匹配 / 内容不可读 / 文件已不在 → no-op。
//    任何文件系统异常吞掉——退出路径上的清理失败降级为「留下陈旧锁」，下次启动自会被判死接管，
//    比让 daemon 崩在一次 unlink 上值钱得多。
//
// —— 已知限制：PID 复用 ——
// 操作系统回收的 PID 被别的进程占用时，defaultIsAlive 判「活」→ 我们拒绝启动。这是正确的
// 保守结果（拒绝的代价是多一次重启；双跑的代价是房间事故），startedAt 比较只是提示、不构成
// 同体证明，故不试图用它消歧。人类侧的出口是 Task 9 的 doctor：报出 holder 信息，人工确认
// 对方进程确实不存在后删掉锁文件。
//
// —— 可移植性（§8.5 承诺 Linux + Windows 双平台）——
// 只用 node:path / node:fs；不假设 unix socket、flock、/proc 存在。Windows 上 EPERM 同样
// 意味着「进程存在但信号不到」——与 Linux 方向一致的保守。
//
// —— 存活探测必须可注入 ——
// 测试不能安全地探测任意真实系统 PID。默认实现 process.kill(pid, 0)：ESRCH=查无此进程（死）；
// EPERM=存在但无权信号（**判活**，保守方向）；其余异常形态一律判活（宁可错拒，不可错抢）。
//
// —— A3 红线 ——
// 锁文件只含 pid/startedAt，永不写入任何凭据；本模块不打日志，抛出的异常文本只含路径。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_FILE_NAME = 'saigai-bot.lock'
// 循环只在「两个接管者互相交错」时多转；正常流程一或两轮收口。耗尽 = 锁在反复易主且轮
// 轮陈旧/活变，环境异常，保守拒绝交人类（Task 9 doctor 的可见面）。
const MAX_ATTEMPTS = 8

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH' // EPERM 与其它未知形态 → 活（保守）；唯 ESRCH → 死
  }
}

function readRawOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    // 缺文件与 IO 失败统一 null。对锁而言「读不到」与「不存在」是同一等级的既有事实：
    // 前者走陈旧接管、后者走直接创建，两条都不许抛（接管路径自己兜得住）。
    return null
  }
}

/**
 * 文本 → {pid, startedAt}；任何畸形（非字符串 / 坏 JSON / 标量 / 数组 / 缺字段 / pid 非正
 * 整数）→ null（= 不可读 = 陈旧）。刻意不 rethrow：脏文件不永挂 daemon，且 V8 的
 * SyntaxError message 可能内嵌输入切片（A3：异常文本不夹带盘上内容）。
 */
function parseHolderOrNull(text) {
  if (typeof text !== 'string') return null
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  if (!Number.isInteger(doc.pid) || doc.pid <= 0) return null
  if (!Number.isFinite(doc.startedAt)) return null
  return { pid: doc.pid, startedAt: doc.startedAt }
}

/**
 * 拿进程级单实例锁。成功返回句柄（release 只删自己的锁）；被活着的他人持有则返回 ok:false +
 * holder，调用方打印 holder.pid 后退出（绝不静默、绝不双跑）。tookOver:true 时调用方应打
 * WARN（§7.4：接管陈旧锁要留痕）。
 * @param {{ dir: string, fileName?: string, pid?: number, startedAt?: number,
 *   isAlive?: (pid: number) => boolean }} options dir = 数据目录（不存在则递归创建，
 *   锁与 state.json 同级）。pid/startedAt/isAlive 均可注入：测试用假 PID，生产走默认。
 * @returns {{ ok: true, tookOver: boolean, release: () => void } |
 *   { ok: false, holder: { pid: number|null, startedAt: number|null } }}
 */
export function acquireLock({
  dir,
  fileName = DEFAULT_FILE_NAME,
  pid = process.pid,
  startedAt = Date.now(),
  isAlive = defaultIsAlive,
}) {
  const filePath = path.join(dir, fileName)
  const content = JSON.stringify({ pid: pid, startedAt: startedAt }) + '\n'
  fs.mkdirSync(dir, { recursive: true }) // 首启时数据目录可能还不存在：锁与 state 同归 dir，由先到者建

  // O_EXCL 创建。true=我拿到了；false=EEXIST（场上已有锁文件）。其余异常（EACCES/EROFS/
  // ENOSPC…）原样上抛：真实故障绝不允许被当成「无锁」继续跑。
  function tryCreateExclusive() {
    let fd
    try {
      fd = fs.openSync(filePath, 'wx')
    } catch (e) {
      if (e.code === 'EEXIST') return false
      throw e
    }
    try {
      fs.writeFileSync(fd, content)
    } finally {
      fs.closeSync(fd)
    }
    return true
  }

  function makeHandle(tookOver) {
    function release() {
      // 只删自己的锁：接管场景里「死持有者」的旧文件已被清、新主人持有同名文件——
      // pid+startedAt 对不上就是别人的，不碰。读不出/已消失 → 同样 no-op（无从认领）。
      try {
        const holder = parseHolderOrNull(readRawOrNull(filePath))
        if (holder === null) return
        if (holder.pid !== pid || holder.startedAt !== startedAt) return
        fs.unlinkSync(filePath)
      } catch (e) {
        /* 退出路径不崩：清理失败退化为陈旧锁，下次启动按死持有者接管 */
      }
    }
    return { ok: true, tookOver: tookOver, release: release }
  }

  let lastHolder = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (tryCreateExclusive()) {
      return makeHandle(false) // 场上无锁（或刚好被清干净）：常态拿锁
    }

    const observed = readRawOrNull(filePath)
    if (observed === null) continue // EEXIST 后瞬间消失（对手 release/清理）：回到顶重试创建

    const holder = parseHolderOrNull(observed)
    if (holder !== null && isAlive(holder.pid)) {
      // A5：活锁绝不抢——不 unlink、不等待重试、不覆写，报出持有者交人类处置。
      return { ok: false, holder: { pid: holder.pid, startedAt: holder.startedAt } }
    }
    // 陈旧：PID 已死，或内容不可读（坏 JSON/缺字段）。
    lastHolder = holder

    // 防线①（unlink 前确认）：复读与观察值不一致 → 别人已抢先行动（比如刚写完新锁），
    // 回到顶部重读+判活；盲删会把对手的新鲜锁连根拔掉。
    const current = readRawOrNull(filePath)
    if (current !== null && current !== observed) continue
    if (current !== null) {
      try {
        fs.unlinkSync(filePath)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e // 已被他人删除 = 无物可清，直接进重建
      }
    }
    // 防线②（unlink 后重新 O_EXCL）：对手抢先写出则 EEXIST → 回到顶部读锁+判活，
    // 对手活着我们就以 ok:false 收口——输家绝不带着「陈旧锁已清」的错觉继续跑。
    if (tryCreateExclusive()) {
      return makeHandle(true)
    }
  }

  // 尝试耗尽（理论上需两个接管者乒乓 MAX 轮）：保守拒绝。holder 给最后一次读到的持有者，
  // 从未读到过合法内容则 {pid:null, startedAt:null}——Task 9 按「持有者未知」打印。
  return {
    ok: false,
    holder: lastHolder === null ? { pid: null, startedAt: null } : { pid: lastHolder.pid, startedAt: lastHolder.startedAt },
  }
}
