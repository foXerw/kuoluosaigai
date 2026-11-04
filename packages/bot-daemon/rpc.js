// Task 10：本地控制面——rpc.json + 127.0.0.1 只读 status 服务（裁定 Q12）。
//
// —— 为什么是「回环 HTTP + rpc.json{port,secret}」而不是 unix socket ——
// §8.5 承诺 Linux + Windows 双平台，而 unix socket 是排他的（Windows 形态不同/不可依赖）。
// Q12 的定案：daemon 监听内核分配的 127.0.0.1 端口，把 {port, secret, pid, startedAt}
// 落进数据目录的 rpc.json；`status` 子命令读它、带 secret 发一次只读 GET。端口随重启变、
// secret 每次新铸——盘上这份文件就是「本机 status 的门牌」， close() 必须摘牌（删文件），
// 否则死端口的陈旧门牌会把操作者引向一次挂死或一次误连。
//
// —— Windows 下真正的防线是什么（brief 点名要写进文档的话）——
// `fs.chmodSync(rpc.json, 0o600)` 是**尽力而为**：Windows 的 ACL 模型不吃 POSIX 位，
// chmod 可能静默无效。保护**从不依赖文件权限**，它依赖两件事：①服务器只绑 127.0.0.1/::1
// （回环之外没有任何路由可达，非回环 host 在入口就被 TypeError 拒掉）；②每个请求必须带
// 与 rpc.json 一致的 secret（≥16 随机字节 hex）。status 的帮助文本里也原话说这条，
// 别让任何人把「600」当护栏。
//
// —— A3 在本文件的落点：只有一个只读端点，别的都不存在 ——
// GET /status → snapshot() JSON。此外：未知路径 404、非 GET 405、超限 body 413——
// 全部**不回显请求内容**（响应体是常量字面量），全部**不调用** snapshot provider。
// 没有指令通道、没有 URL 参数、没有任何可被拿来当 SSRF 跳板/放大器的形状。
//
// —— A1 零 key 材料 ——
// 本模块只搬运 Task 7 `host.snapshot()` 的产物——它已是白名单拼装的（providers 整个
// 不进快照）；Task 5 的 state.js 从不落 apiKey。所以「响应零 key」在结构上成立，
// 本文件自己也不产生任何带 key 的文本；snapshot 抛异常时回 500 **固定体**（A3：V8 异常
// 文本可能内嵌输入切片，绝不把 err.message 写进响应）。
//
// —— 401 的等体与时序（A7 精神的控制面侧）——
// 缺 secret 与错 secret 返回**逐字节相同**的 401 体——不给「这个头没带 vs 带错了」的
// 枚举 oracle。比较走 SHA-256 摘要 + timingSafeEqual：长度不同也恒定耗时，secret 不配
// 有逐字节短路的旁路。
//
// —— 放大器防线：数而不存 ——
// 请求体**不缓冲**（一个字节都不存），只累计字节数；越过 readBodyLimit 立即回 413 +
// `connection: close`，剩余字节 drain 掉让 socket 干净收口（不 RST 半程断——协议测试的
// 确定性优先于省那点回环带宽）。控制口不是任何人的信箱。
//
// —— 句柄纪律（Task 9 教训的延续）——
// listen 失败 → Promise reject，不留半个 server；rpc.json 写失败 → **先关掉刚 listen 成功
// 的端口**再原样上抛（宁可没有 status 面，也不留裸听端口）；close() 幂等、
// closeAllConnections 兜住 keep-alive 空闲套接字，否则测试进程会被挂着的连接拖死。
// 删除 rpc.json 前做 pid+port+secret 对账——场上若有继任 daemon 已改写门牌，盲删会把
// 活人的门牌撕了（lock.release 同款纪律）。
//
// —— readRpcFile 是 status 侧的眼 ——
// 三态：missing（没门牌）/ unreadable（读不动，EACCES/EISDIR 类）/ malformed（坏 JSON、
// 缺字段、port 不在 1..65535、secret 短于 32 hex、pid 非正整数）。判不出合法形状一律
// malformed（= 陈旧，daemon 大概率已死），永不抛、异常文本不回显（A3 同 lock.js 的
// parseHolderOrNull）。
//
// —— runStatus：控制面的读端也归本文件 ——
// server 与 client 必须共享同一份协议形状（rpc.json 字段、header 名、URL、超时预算），
// 拆在两个文件里就是让两份理解各自漂移的起点。CLI 的 status 子命令只做用法校验与
// 退出码映射（cli.js），查询与渲染全在这（runStatus → statusRender）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const RPC_FILE_NAME = 'rpc.json'
export const SECRET_HEADER = 'x-saigai-secret'
export const READ_BODY_LIMIT = 8192 // 状态查询没有 body；上限只为「谁乱塞」兜底，不是配额

// 回环 allowlist 是**写死的两条**（A3）：'localhost' 不进表——hosts 文件可以把它指到
// 任何地址，控制面不接受这种「名字随缘」。
const LOOPBACK_HOSTS = ['127.0.0.1', '::1']

const UNAUTHORIZED_BODY = JSON.stringify({ error: 'unauthorized' }) // 缺/错 secret 共用（A7 精神）
const NOT_FOUND_BODY = JSON.stringify({ error: 'not-found' })
const METHOD_NOT_ALLOWED_BODY = JSON.stringify({ error: 'method-not-allowed' })
const BODY_TOO_LARGE_BODY = JSON.stringify({ error: 'body-too-large' })
const SNAPSHOT_FAIL_BODY = JSON.stringify({ error: 'snapshot-unavailable' })

/** 密码学随机 secret：n 字节 → 2n 位小写 hex。生产默认 16 字节（32 hex），不得更短。 */
export function randomHex(byteLength = 16) {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new RangeError('randomHex: 字节数必须是 ≥16 的整数（控制面凭据下限，Q12）')
  }
  return crypto.randomBytes(byteLength).toString('hex')
}

function isHexSecret(v) {
  return typeof v === 'string' && /^[0-9a-f]{32,}$/.test(v)
}

// 等时比较：对两边各取 SHA-256 摘要再 timingSafeEqual——长度不等也恒定耗时，
// 错误比较本身不许携带「差在第几位/长度是多少」的信息。
function secretMatches(presented, secret) {
  if (typeof presented !== 'string' || presented === '') return false
  const a = crypto.createHash('sha256').update(presented).digest()
  const b = crypto.createHash('sha256').update(secret).digest()
  return crypto.timingSafeEqual(a, b)
}

function sendJson(res, status, body, extraHeaders) {
  const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {})
  res.writeHead(status, headers)
  res.end(body)
}

function parseRpcOrNull(text) {
  if (typeof text !== 'string') return null
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return null // 刻意不 rethrow：V8 切片可能内嵌盘上内容（A3），且三态判据用不上原文
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  if (!Number.isInteger(doc.port) || doc.port <= 0 || doc.port > 65535) return null
  if (!isHexSecret(doc.secret)) return null
  if (!Number.isInteger(doc.pid) || doc.pid <= 0) return null
  if (!Number.isFinite(doc.startedAt)) return null
  return { port: doc.port, secret: doc.secret, pid: doc.pid, startedAt: doc.startedAt }
}

/**
 * 读数据目录里的 rpc.json（status 侧）。永不抛。
 * @returns {{ ok: true, info: {port:number, secret:string, pid:number, startedAt:number}, path: string } |
 *   { ok: false, why: 'missing'|'unreadable'|'malformed', path: string }}
 */
export function readRpcFile({ dir, fileName = RPC_FILE_NAME } = {}) {
  const filePath = path.join(dir, fileName)
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    const code = e && e.code
    return { ok: false, why: code === 'ENOENT' ? 'missing' : 'unreadable', path: filePath }
  }
  const info = parseRpcOrNull(raw)
  if (info === null) return { ok: false, why: 'malformed', path: filePath }
  return { ok: true, info, path: filePath }
}

/**
 * 起本地控制服务：listen(0, 回环) → 成功后落 rpc.json → 返回句柄。
 * @param {{
 *   snapshot: () => object,                     // Task 7 host.snapshot（每请求实时取，brief Step 3）
 *   dir: string,                                // 数据目录（rpc.json 落点，与锁/state 同级）
 *   host?: string,                              // 只准 127.0.0.1/::1，其余 TypeError
 *   secret?: string,                            // 缺省 randomHex(16)；注入也须 ≥32 hex
 *   readBodyLimit?: number,                     // 请求体字节上限（数而不存，超限 413）
 *   pid?: number, startedAt?: number,           // rpc.json 记账字段（测试可注入）
 * }} options
 * @returns {Promise<{ port: number, secret: string, rpcPath: string, close: () => Promise<void> }>}
 */
export async function startControlServer({
  snapshot,
  dir,
  host = '127.0.0.1',
  secret,
  readBodyLimit = READ_BODY_LIMIT,
  pid = process.pid,
  startedAt = Date.now(),
} = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('startControlServer: snapshot 必须是函数（Task 7 host.snapshot 的接线面）')
  if (typeof dir !== 'string' || dir === '') throw new TypeError('startControlServer: dir 必填（rpc.json 落数据目录）')
  if (LOOPBACK_HOSTS.indexOf(host) === -1) {
    throw new TypeError('startControlServer: 只准绑回环（A3/Q12），拒绝 host=' + host)
  }
  const finalSecret = secret === undefined ? randomHex(16) : secret
  if (!isHexSecret(finalSecret)) throw new TypeError('startControlServer: secret 必须是 ≥32 位 hex（16 随机字节下限）')
  const limit = Number.isInteger(readBodyLimit) && readBodyLimit > 0 ? readBodyLimit : READ_BODY_LIMIT

  const rpcPath = path.join(dir, RPC_FILE_NAME)
  let fileWritten = false

  function handleRequest(req, res) {
    // 放大器防线（先于鉴权）：body **只数不存**，越线即 413 + connection close。
    // 之后剩余字节 drain（resume）让内核/socket 干净收口——不 RST，协议测试要确定性。
    let seen = 0
    let killed = false
    req.on('data', (chunk) => {
      if (killed) return
      seen += chunk.length
      if (seen > limit) {
        killed = true
        sendJson(res, 413, BODY_TOO_LARGE_BODY, { connection: 'close' })
        req.resume()
      }
    })
    req.on('error', () => {
      killed = true // 客户端半程断裂/超时：路由阶段不再回话
    })
    req.on('end', () => {
      if (killed || res.headersSent) return
      if (!secretMatches(req.headers[SECRET_HEADER], finalSecret)) {
        sendJson(res, 401, UNAUTHORIZED_BODY) // 缺与错共用同一体（A7 精神）
        return
      }
      if (req.url !== '/status') {
        sendJson(res, 404, NOT_FOUND_BODY) // 不回显 req.url（A3），不碰 snapshot（A3 只读一个端点）
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, METHOD_NOT_ALLOWED_BODY)
        return
      }
      let snap
      try {
        snap = snapshot()
      } catch (e) {
        sendJson(res, 500, SNAPSHOT_FAIL_BODY) // 固定体：异常文本可能带切片（A3），绝不外泄
        return
      }
      sendJson(res, 200, JSON.stringify(snap))
    })
  }

  const server = http.createServer(handleRequest)

  function closeServer() {
    return new Promise((resolve) => {
      // keep-alive 空闲连接不关，server.close() 会一直等——Task 9 的教训：泄漏的 socket
      // 句柄能挂死整个进程。closeAllConnections 是 Node ≥18.2（engines ≥22 蕴含在场）。
      try {
        server.closeAllConnections()
      } catch (e) {
        /* best-effort；下面 close 的回调仍会落定 */
      }
      server.close(() => resolve())
    })
  }

  // listen 前的 error 归 reject；listen 成功后的杂散 server 错误（socket 层边角）吞掉——
  // 24/7 进程里一个无主 error 就是崩进程。
  let listening = false
  await new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (!listening) reject(err)
    })
    server.listen(0, host, () => {
      listening = true
      resolve()
    })
  })

  const doc = { port: server.address().port, secret: finalSecret, pid, startedAt }
  try {
    fs.mkdirSync(dir, { recursive: true })
    // tmp+rename 原子写（state.js 同款）：status 读到的一半永远是完整的 JSON，
    // 不会看到「写到半个 port」这种把 malformed 率推向随机的形态。
    const tmpPath = rpcPath + '.tmp'
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(doc) + '\n')
      try {
        // Windows 下 chmod 是尽力而为（可能静默无效）：**防线是回环绑定 + secret，不是文件模式**。
        fs.chmodSync(tmpPath, 0o600)
      } catch (e) {
        /* 尽力而为，见文件头 */
      }
      fs.renameSync(tmpPath, rpcPath)
      fileWritten = true
    } finally {
      try {
        if (!fileWritten && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      } catch (e) {
        /* 残骸清理失败不掩盖原始异常 */
      }
    }
  } catch (err) {
    // 门牌写不下去 = status 永远看不见这个 daemon。先把刚 listen 成功的端口关掉
    // （宁可观测面缺失，绝不留裸听端口），再把原始错误交调用方（run 大声记录但让 bot 跑）。
    await closeServer()
    throw err
  }

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    // 先摘牌后关门：关停竞态里 status 只会得到「没 rpc.json → 未在运行」的诚实答案，
    // 而不是「门牌在场、端口已死」的误导形态。只删**对得上账**的（lock.release 同款）。
    if (fileWritten) {
      try {
        const current = parseRpcOrNull(fs.readFileSync(rpcPath, 'utf8'))
        if (current !== null && current.port === doc.port && current.secret === doc.secret && current.pid === doc.pid) {
          fs.unlinkSync(rpcPath)
        }
      } catch (e) {
        /* 摘牌失败不拖垮关停：文件还在也只指向死端口，status 侧有界失败（ECONNREFUSED 分支） */
      }
    }
    await closeServer()
  }

  return { port: doc.port, secret: finalSecret, rpcPath, close }
}

// ============================================================================
// —— status 客户端（控制面的读端；CLI 的 status 子命令经此落地，见 cli.js 的薄接线）——
// 放在本文件的唯一理由：控制面的**形状知识**（rpc.json 字段、header 名、URL、三态文案的
// 判据原料）集中在一处，server 与 client 不许对同一份协议各写一份理解。CLI 面只留
// 用法校验与退出码映射。渲染与文案的钉死断言在 tests/cli.test.js（不动语义，只动归属）。
// ============================================================================

const STATUS_TIMEOUT_MS = 5000 // 控制口在同机回环上；秒级不响应=卡死。有界失败好过挂终端。

function statusRender(o, snap, dataDir) {
  const print = o.print
  const meta = snap && typeof snap === 'object' && snap.meta && typeof snap.meta === 'object' ? snap.meta : null
  const bots = snap && Array.isArray(snap.bots) ? snap.bots : null
  if (!meta || !bots) {
    o.printErr('FAIL: 控制口返回 200 但形状不是 {meta, bots}（版本错配？）——渲染面不做猜测，不输出半张表')
    return false
  }
  // R26/R28/R31：粘滞位永远占第一行——「不可能看漏」这条验收写的就是 status 的输出面。
  if (meta.restartRequired) {
    print('!! restartRequired（粘滞位）：limits/serverUrl 一类变更要**重启 daemon 进程**才生效——当前进程仍在旧闸与旧地址上运行。')
    print('!! 处置：重启本进程（systemd 托管就 systemctl restart）；此提示在进程重启前不会消失，也不会被热重载洗掉（R28）。')
  }
  print('saigai-bot status —— daemon「' + (typeof meta.name === 'string' ? meta.name : '(无名)') + '」（数据目录 ' + dataDir + '）')
  // Q12 新鲜度口径：报「数据为 N 秒前」，不宣称与实时相等；>5s 就如实说超窗。
  const nowFn = o.now || Date.now
  const ageSec = Number.isFinite(meta.generatedAt) ? Math.max(0, Math.floor((nowFn() - meta.generatedAt) / 1000)) : null
  if (ageSec === null) {
    print('数据时点：未知（快照没带可解析的 generatedAt——渲染面不猜）')
  } else if (ageSec > 5) {
    print('数据为 ' + ageSec + ' 秒前——已超过 ≤5s 新鲜度口径（控制面按请求实时取数，不该这么旧：怀疑时钟跳变或 daemon 卡滞）')
  } else {
    print('数据为 ' + ageSec + ' 秒前（Q12 新鲜度口径：≤5s 视为新鲜）')
  }
  print('deviceId：' + (meta.deviceId === null || meta.deviceId === undefined ? 'null（P1 事实：设备令牌尚未铸造，非配对遗漏；字段在场≠已接线，R30）' : String(meta.deviceId)))
  print('进程运行时长：' + (Number.isFinite(meta.uptimeMs) ? Math.floor(meta.uptimeMs / 1000) + ' 秒' : '未知'))
  print('全局小时闸：' + (meta.globalHourCount === null || meta.globalHourCount === undefined ? '未配置（未安装≠未消耗，别读成 0）' : meta.globalHourCount + ' 条/已用（本小时）'))
  print('restartRequired：' + (meta.restartRequired ? '有——见顶部 !! 横幅' : '无待进程重启的变更'))
  if (bots.length === 0) {
    print('bots：0（deck 空转，daemon 活着）')
  } else {
    print('bots：' + bots.length + ' 个（room 列为**有效房**非配置值，R20；nick 是服务器分配的身份）')
    for (const b of bots) {
      const s = b.session || {}
      const lt = b.lifetime || {}
      print(
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
    const store = o.createStore({ dir: dataDir })
    orphans = store.readOrphans()
  } catch (e) {
    orphanErr = (e && (e.code || e.name)) || '未知'
  }
  if (orphanErr !== null) {
    print('孤儿身份：未能读取 state.json（' + orphanErr + '）——不影响上方读数，如实说不知道')
  } else {
    const ids = Object.keys(orphans || {})
    print('孤儿身份（state.orphans，Q2 防误删保留）：' + ids.length + ' 个' + (ids.length > 0 ? ' → ' + ids.join(', ') : ''))
    if (ids.length > 0) {
      print('  孤儿条目没有自动 GC；在**运行中的 daemon** 手改 state.json 删不掉它们——适配器按缓存基准重播，下一次写就复活。')
      print('  唯一正确的清除路径：先停 daemon → 删除数据目录里的 state.json（等价 removeItem，身份与账目一并抹除）或换新的 --data-dir → 再启动。')
    }
  }
  return true
}

/**
 * status 子命令的真身：读 rpc.json → 带 secret 一次 GET /status（限时自断）→ 渲染。
 * 失败分型文案互不相同（未在运行/读不出/陈旧/超时/401/HTTP 异常/坏 JSON/形状错），
 * 调用方（cli.js）只做用法校验与退出码映射。输出零 secret、零 key 材料、零响应体回显。
 * @param {{ dir: string, print: Function, printErr: Function, readRpcFile?: Function,
 *   fetchImpl?: Function, createStore: Function, now?: () => number, statusTimeoutMs?: number }} o
 * @returns {Promise<boolean>} true=成功渲染（退 0）；false=任一失败分型（退 1）
 */
export async function runStatus(o) {
  const rpc = (o.readRpcFile || readRpcFile)({ dir: o.dir })
  if (!rpc.ok) {
    // 三条独立文案（派发钉的验收）：「没门牌」/「门牌读不动」/「门牌是陈旧的」。
    if (rpc.why === 'missing') {
      o.printErr('FAIL: ' + rpc.path + ' 不在——daemon 未在运行？（只有 saigai-bot run 会写它、干净关停时拆掉它）')
    } else if (rpc.why === 'unreadable') {
      o.printErr('FAIL: ' + rpc.path + ' 在场但读不出（权限/IO 故障）——daemon 未在运行，或数据目录没指对？')
    } else {
      o.printErr('FAIL: ' + rpc.path + ' 在场但解不出合法 {port,secret,pid,startedAt}——陈旧 rpc.json：daemon 死过一次没来得及摘牌？')
    }
    return false
  }
  const fetchImpl = o.fetchImpl || ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = typeof o.statusTimeoutMs === 'number' && o.statusTimeoutMs > 0 ? o.statusTimeoutMs : STATUS_TIMEOUT_MS
  const url = 'http://127.0.0.1:' + rpc.info.port + '/status'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { [SECRET_HEADER]: rpc.info.secret }, signal: controller.signal })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      o.printErr('FAIL: 控制口 127.0.0.1:' + rpc.info.port + ' 请求超时（' + timeoutMs + 'ms 内无响应）——已主动掐断，有界失败不挂死。daemon 卡滞或机器极忙？')
    } else {
      const why = (err && err.cause && err.cause.message) || (err && err.message) || '未知网络错误'
      o.printErr('FAIL: 连不上 127.0.0.1:' + rpc.info.port + '（' + why + '）——陈旧 rpc.json：daemon 已死但没来得及摘牌。重启 daemon 或确认其不存在后删掉 ' + rpc.path)
    }
    return false
  } finally {
    clearTimeout(timer) // 超时定时器必清（Task 9 句柄纪律）
  }
  let text
  try {
    text = await res.text() // 非 200 也读完：keep-alive 套接字不许揣着未读 body 走人
  } catch (err) {
    o.printErr('FAIL: 读取控制口响应体失败（' + ((err && (err.code || err.name)) || '未知') + '）')
    return false
  }
  if (res.status === 401) {
    // 服务端对「缺 secret」与「错 secret」回**同一响应体**（A7 精神）——这里同样不猜是谁被拒，只说事实。
    o.printErr('FAIL: 401——rpc.json 里的 secret 与在场 daemon 不匹配（多半是 daemon 重启后重铸了 secret、而你手上这份 rpc.json 是旧门牌的缓存）。重新跑一次 status 即可；仍 401 就检查数据目录里是否只有一份 saigai-bot 的 rpc.json')
    return false
  }
  if (res.status !== 200) {
    o.printErr('FAIL: 控制口返回 HTTP ' + res.status + '（预期 200）——端口在场但答复不对，这个 rpc.json 指向的未必是 saigai-bot 的控制口')
    return false
  }
  let snap
  try {
    snap = JSON.parse(text)
  } catch (e) {
    o.printErr('FAIL: 控制口 200 响应体不是合法 JSON（不回显内容，A3）——端口被别的服务占了？')
    return false
  }
  return statusRender(o, snap, o.dir)
}
