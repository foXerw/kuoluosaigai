// Task 9：`saigai-bot doctor`——环境体检（§5、§8.2、§16）。
//
// —— 这份文件存在的首要理由 ——
// §5/§16 钉着一条**从未实测**的前提：PVE 虚拟机出网能否稳定连到 DeepSeek/Kimi/OpenRouter
// （此前的 CORS 数据来自用户家庭网络，不能推定 VPS 同样可达）。§8.6 要求 doctor 对它给出
// **明确结论**——所以 provider 连通性是"真发一次最小 chat 请求"，不是查配置字段；
// 判不出来就印 FAIL，**绝不 OK、绝不耸肩**。依赖配置的探测（provider/WS/时钟）在配置
// 坏掉时必须 FAIL 并写明"未实测"（A5 同源：输出永远有声音）。
//
// —— 裁定 R5：WS 可达性用裸 `new WebSocket(url)`，不许用 createBotConnection ——
// 可达性判据是 **TCP/TLS/握手层**能不能通；createBotConnection 会把**协议**（assign/joined
// 帧、会话状态机）折进判据——服务器活着但协议改版时，doctor 会误判"网络不通"，运维方向全错。
// 所以这里只 open→视为可达→立刻 close，一帧业务都不发。R5 同时否决了 `ws` 包（裁定 D1：
// Node ≥22 原生 WebSocket，零依赖）。
//
// —— A1/A3 红线在本文件的落点 ——
// apiKey 只在两处存在过：validateConfig 的 cfg 字段、chatCompletion 的 Authorization 头
// （core B9 已证 LlmError.message/detail 不含 key）。本文件打印的每一行都过同一把尺：
// 只印 kind、HTTP 状态、耗时、偏移秒数、路径——绝不印响应体、绝不印 cfg.provider.apiKey。
// provider baseUrl 与 serverUrl 是公开端点，允许出现在输出里（运维需要知道"哪个没通"）。
//
// —— 时钟检查为什么借 provider 的 HTTP `Date` 头 ——
// 「本地时钟偏移」离线无从测量：VM 无 NTP/从快照复活时墙钟可以整小时地错，而静默窗（R9）
// 与小时闸吃的正是墙钟。复用注入的 fetchImpl 对 provider 发一次**零成本 HEAD**，读响应
// Date 头作基准；取不到基准（网络断/缺头）就 FAIL「未获认证」——体检仪不认证它没测过的东西。
// 阈值 300s：HH:MM 粒度与小时桶对这个量级以下的偏差无感，快照复活级的偏差远在其上。
//
// —— 网络面全部可注入（测试零真网）——
// fetchImpl / WebSocketImpl / load / now / sleep 与 Node 版本、全局 WS 在场性都是参数；
// 缺省走真环境（globalThis.fetch / globalThis.WebSocket / loadConfig / Date.now）。
// 探测句柄纪律与 Task 8 同款：超时定时器**必清**，open 成功**必 close**，不留悬挂句柄。

import fs from 'node:fs'
import path from 'node:path'

import { chatCompletion, LlmError } from 'kuoluosaigai-bot-core'
import { loadConfig, validateConfig, ConfigLoadError } from './config.js'

export const NODE_MIN_MAJOR = 22
export const CHAT_TIMEOUT_MS = 15000 // 出网实测的耐心：跨洋 TLS 握手 + 最小推理
export const CHAT_RETRY_DELAY_MS = 1000 // 透传给 core 的重试节奏（rate/server/timeout/network 恰好重试一次）
export const WS_TIMEOUT_MS = 10000
export const CLOCK_THRESHOLD_MS = 300000 // 5 分钟：见文件头论证

const TOTAL_CHECKS = 7

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// provider 失败的**分型文案**（brief 用例：429 要与 auth 可分辨——"没配额"与"key 错"是两种运维动作）。
function providerFailLine(err) {
  const detail = err.detail ? '（' + err.detail + '）' : ''
  if (err.kind === 'auth') return '鉴权失败' + detail + '：apiKey 无效/过期/无权限——这是 key 的事，与限流是两回事'
  if (err.kind === 'rate') return '被限流或配额耗尽' + detail + '：网络、TLS、key 都通，服务商拒绝更多请求——与 401/403 的鉴权是两回事，别去换 key'
  if (err.kind === 'server') return '服务商 5xx' + detail + '：出网通、请求到达了，对面没接住'
  if (err.kind === 'timeout') return '请求超时' + detail + '：出网可能被墙/被黑洞，或服务商过慢'
  if (err.kind === 'network') return '网络层失败' + detail + '：DNS/TLS/出网任一环节断'
  if (err.kind === 'bad-response') return '响应畸形' + detail + '：通了但不是 OpenAI 兼容形状'
  return '未分类失败（' + err.kind + '）' + detail
}

// —— R5 裸 WS 握手探测：只认 open/error/close 三个握手层事实，超时定时器必清 ——
function probeWebSocket(url, WebSocketImpl, timeoutMs) {
  return new Promise((resolve) => {
    let ws = null
    try {
      ws = new WebSocketImpl(url)
    } catch (e) {
      resolve({ ok: false, why: '构造 WebSocket 抛错（' + (e && e.name ? e.name : String(e)) + '）' })
      return
    }
    if (!ws || typeof ws.addEventListener !== 'function' || typeof ws.close !== 'function') {
      resolve({ ok: false, why: 'WebSocket 实现缺少 addEventListener/close 端口' })
      return
    }
    let settled = false
    let timer = null
    function onOpen() {
      finish({ ok: true })
      try {
        ws.close() // 可达性已证，一帧业务都不发、一秒都不多留（R5）
      } catch (e) {
        /* 关不掉也不改变判据 */
      }
    }
    function onError() {
      finish({ ok: false, why: '握手失败（TCP/TLS/HTTP upgrade 任一环节被拒或断裂）' })
    }
    function onClose(ev) {
      finish({ ok: false, why: '握手完成前连接被关闭（code ' + (ev && ev.code != null ? ev.code : '?') + '）' })
    }
    function finish(result) {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      } catch (e) {
        /* 摘不掉也不改变判据 */
      }
      resolve(result)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
    timer = setTimeout(() => {
      finish({ ok: false, why: '握手超时（' + timeoutMs + 'ms 内未收到 open）' })
    }, timeoutMs)
  })
}

/**
 * 跑 7 项体检，逐项打印 `OK`/`FAIL`（不含任何 key 材料），返回退出码。
 * @param {{
 *   configPath?: string, dataDir?: string,
 *   print?: (line: string) => void,
 *   load?: (p: string) => Promise<unknown>,              // 缺省 loadConfig（真 ESM 重导入）
 *   fetchImpl?: Function, WebSocketImpl?: Function,      // R5/D1：探测面注入，测试零真网
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   nodeVersion?: string, hasNativeWebSocket?: boolean,  // 环境在场性（测试覆盖两条分支）
 *   chatTimeoutMs?: number, wsTimeoutMs?: number, clockThresholdMs?: number,
 * }} options
 * @returns {Promise<number>} 0 全过；1 任一 FAIL
 */
export async function runDoctor(options) {
  const o = options || {}
  const print = o.print || ((line) => { try { console.log(line) } catch (e) { /* 输出面不许炸体检 */ } })
  const now = o.now || Date.now
  const fetchImpl = o.fetchImpl || ((input, init) => globalThis.fetch(input, init))
  const WebSocketImpl = o.WebSocketImpl || globalThis.WebSocket
  const load = o.load || ((p) => loadConfig(p))
  const sleep = o.sleep || defaultSleep
  const configPath = o.configPath
  const dataDir = o.dataDir
  const chatTimeoutMs = o.chatTimeoutMs || CHAT_TIMEOUT_MS
  const wsTimeoutMs = o.wsTimeoutMs || WS_TIMEOUT_MS
  const clockThresholdMs = o.clockThresholdMs || CLOCK_THRESHOLD_MS

  let failed = 0
  let index = 0
  let cfg = null // 第 3 项的产物；不合法则后续依赖项 FAIL「未实测」

  async function check(name, fn) {
    index += 1
    let result
    try {
      result = await fn()
    } catch (e) {
      // 体检仪自身被单项炸出不行：任何逃逸异常都归该 FAIL，逐行照印有声音。
      result = { ok: false, why: '检查自身抛出未预期异常（' + (e && e.name ? e.name : String(e)) + '）' }
    }
    const tag = result.ok ? 'OK  ' : 'FAIL'
    if (!result.ok) failed += 1
    print(tag + ' [' + index + '/' + TOTAL_CHECKS + '] ' + name + '：' + result.detail)
    if (result.extra) {
      for (const line of result.extra) print('      ' + line)
    }
  }

  await check('Node 版本', () => {
    const v = o.nodeVersion !== undefined ? o.nodeVersion : process.versions.node
    const major = parseInt(String(v).split('.')[0], 10)
    const ok = Number.isFinite(major) && major >= NODE_MIN_MAJOR
    return { ok, detail: 'v' + v + (ok ? '（要求 ≥' + NODE_MIN_MAJOR + '）' : '——不满足 ≥' + NODE_MIN_MAJOR + '，P1 的连接形态不成立') }
  })

  await check('原生 WebSocket', () => {
    const present = o.hasNativeWebSocket !== undefined ? o.hasNativeWebSocket : typeof globalThis.WebSocket === 'function'
    return {
      ok: present,
      detail: present
        ? 'globalThis.WebSocket 在场（裁定 D1：零依赖，禁 ws 包）'
        : 'globalThis.WebSocket 缺失——装 Node ≥22 或带 --experimental-websocket（R5 的连接形态依赖它）',
    }
  })

  await check('配置校验', async () => {
    let raw
    try {
      raw = await load(configPath)
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        // kind **如实透传**（Task 4 parked Minor②：求值期抛实现归 'unparsable'，判读不继承旧注释标签）。
        return { ok: false, detail: '读取失败（' + err.kind + '）：' + err.message }
      }
      throw err
    }
    const res = validateConfig(raw)
    if (!res.ok) {
      return { ok: false, detail: '非法（' + res.errors.length + ' 条）', extra: res.errors }
    }
    cfg = res.cfg
    return { ok: true, detail: '纯数据校验通过（bots: ' + res.cfg.bots.length + '）' }
  })

  await check('provider 连通性', async () => {
    if (!cfg) return { ok: false, detail: '未实测：配置校验未通过，没有 provider 参数可测' }
    const t0 = now()
    try {
      await chatCompletion({
        provider: { baseUrl: cfg.provider.baseUrl, apiKey: cfg.provider.apiKey },
        model: cfg.provider.model,
        messages: [{ role: 'user', content: 'doctor 连通性探测：请只回复一个"好"字' }],
        temperature: 0,
        timeoutMs: chatTimeoutMs,
        retryDelayMs: CHAT_RETRY_DELAY_MS,
        fetchImpl,
        sleep,
      })
      return {
        ok: true,
        detail:
          '最小 chat/completions 实测成功（耗时 ' +
          Math.max(0, now() - t0) +
          'ms，' +
          cfg.provider.baseUrl +
          '）——§5 出网前提（含 TLS 与鉴权与推理）对本机**已证实可达**',
      }
    } catch (err) {
      if (err instanceof LlmError) {
        return { ok: false, detail: providerFailLine(err) + '——端点 ' + cfg.provider.baseUrl + '（key 不入输出，B9 同源）' }
      }
      return { ok: false, detail: '探测抛出未分类异常（' + (err && err.name ? err.name : String(err)) + '）' }
    }
  })

  await check('serverUrl WS 可达性', async () => {
    if (!cfg) return { ok: false, detail: '未实测：配置校验未通过，没有 serverUrl 可测' }
    const r = await probeWebSocket(cfg.serverUrl, WebSocketImpl, wsTimeoutMs)
    // brief 用例：不可达时**给出 serverUrl**，不谎报 OK。
    const detail = r.ok ? '握手可达（' + cfg.serverUrl + '，open 后即关——可达性判据不含协议帧，R5）' : cfg.serverUrl + '：' + r.why
    return { ok: r.ok, detail }
  })

  await check('本地时钟', async () => {
    if (!cfg) return { ok: false, detail: '未实测：配置校验未通过，没有取基准的端点' }
    let res
    try {
      res = await fetchImpl(cfg.provider.baseUrl, { method: 'HEAD' })
    } catch (e) {
      return { ok: false, detail: '无法取得服务器时间基准（HEAD ' + cfg.provider.baseUrl + ' 网络层失败：' + (e && e.name ? e.name : String(e)) + '）——时钟未获认证' }
    }
    const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null
    const serverMs = header ? Date.parse(header) : NaN
    if (!Number.isFinite(serverMs)) {
      return { ok: false, detail: 'provider 响应缺少可解析 Date 头——时钟偏移未获认证（本体检不认证没测过的东西）' }
    }
    const driftMs = now() - serverMs
    const ok = Math.abs(driftMs) <= clockThresholdMs
    const advice = ok
      ? '静默窗与小时闸可信赖'
      : '：请检查 VM 的 NTP 同步（快照复活/无 NTP 的 VPS 是重灾区，静默窗与小时闸吃的就是墙钟）'
    return {
      ok,
      detail: '本地-服务器偏差 ' + Math.round(driftMs / 1000) + 's（阈值 ' + Math.round(clockThresholdMs / 1000) + 's）' + advice,
    }
  })

  await check('数据目录', () => {
    const probe = path.join(dataDir, '.doctor-write-probe')
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return { ok: true, detail: '可写：' + dataDir }
    } catch (e) {
      return { ok: false, detail: '不可写：' + dataDir + '（' + ((e && (e.code || e.name)) || '未知原因') + '）' }
    }
  })

  print('doctor 结论：' + (failed === 0 ? '全部 ' + TOTAL_CHECKS + ' 项通过' : failed + ' 项 FAIL（共 ' + TOTAL_CHECKS + ' 项）'))
  return failed === 0 ? 0 : 1
}
