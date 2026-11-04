// @vitest-environment node
// Task 11：结构化 stdout 日志 —— 消费 onEvent 且全程 redact（§8.2/A1/A3/Q7/R33）。
//
// 用例分四族：
// ①线形与字段稳定（一行一条合法 JSON、journald 友好、{ts, level, botId?, kind?, msg} 序稳定）；
// ②双策略脱敏（键名匹配 /key|token|secret/i 一律遮 + 已知 key 值全文替换；**两把 key 在场必须都遮**
//   —— 只遮第一条是本族的历史失败形态）；
// ③sink 免疫（Task 1 parked 的 Critical-adjacent：deck.js 裸调宿主汇、runner 在 catch 内发射——
//   日志器的每个公开方法对任何输入都不许外抛，含 BigInt/循环/getter 炸/ownKeys 炸/write 自身炸）；
// ④R33 的 .cause 纪律（cause 原文可能内嵌 V8 输入切片 = 配置内容，只走 config.js 导出的
//   summarizeThrown 同一过滤器，绝不逐字打印）＋ Q7 事件级别映射 ＋ 接线面（cli 缺省 logger、
//   rpc 控制面 500 留痕——Task 10 parked Minor 1）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createLogger } from '../log.js'
import { ConfigLoadError, summarizeThrown } from '../config.js'
import { startControlServer, SECRET_HEADER } from '../rpc.js'
import { main } from '../cli.js'

const KEY_A = 'sk-ALPHA-abcdefg-1111' // 后四位 1111
const KEY_B = 'token-BRAVO-xyzabcp-2222' // 后四位 2222

function capture() {
  const chunks = []
  return {
    chunks,
    write: (s) => chunks.push(String(s)),
    lines: () => chunks.map((c) => JSON.parse(c)),
    all: () => chunks.join(''),
  }
}

describe('Task 11：结构化 stdout 日志（§8.2）', () => {
  it('一行一条合法 JSON：字段序稳定 {ts, level, (botId, kind), msg, ...}，且输出不含 "Authorization"', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1700000000000 })
    logger.info('daemon 已启动')
    expect(cap.chunks.length).toBe(1)
    expect(cap.chunks[0].endsWith('\n')).toBe(true)
    expect(Object.keys(cap.lines()[0])).toEqual(['ts', 'level', 'msg'])
    expect(cap.lines()[0]).toEqual({ ts: 1700000000000, level: 'info', msg: 'daemon 已启动' })
    logger.warn('热重载收敛完成', { botId: 'lixiao', kind: 'rate', detail: 3 })
    expect(Object.keys(cap.lines()[1])).toEqual(['ts', 'level', 'botId', 'kind', 'msg', 'detail'])
    expect(cap.all()).not.toContain('Authorization')
  })

  it('msg 含裸换行仍是一行（JSON 转义），写出的每个 chunk 至多一个 \n', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.info('daemon 已启动') // 先垫一行，证明索引偏移不是巧合
    logger.error('两行\n文本', { detail: 'a\nb' })
    expect(cap.chunks.length).toBe(2)
    expect(cap.chunks[1].split('\n').length).toBe(2)
    expect(JSON.parse(cap.chunks[1]).msg).toBe('两行\n文本')
    expect(JSON.parse(cap.chunks[1]).detail).toBe('a\nb')
  })

  it('ts 缺省走 Date.now、注入走注入时钟（不赌真钟的断言用注入）', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write })
    logger.info('x')
    expect(typeof cap.lines()[0].ts).toBe('number')
    expect(cap.lines()[0].ts).toBeGreaterThan(0)
  })

  it('策略一（键名）：key/token/secret 命名的键在同一次调用里全部遮成 sk-****+后四位——两把在场不许只遮第一条', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.info('provider 已装载', {
      provider: { baseUrl: 'https://api.example.test/v1', apiKey: KEY_A },
      control: { rpcSecret: KEY_B },
      bots: [{ id: 'lixiao', authToken: KEY_B }],
    })
    const line = cap.lines()[0]
    expect(line.provider.apiKey).toBe('sk-****1111')
    expect(line.provider.baseUrl).toBe('https://api.example.test/v1')
    expect(line.control.rpcSecret).toBe('sk-****2222')
    expect(line.bots[0].authToken).toBe('sk-****2222')
    expect(line.bots[0].id).toBe('lixiao')
    const text = cap.all()
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain(KEY_B)
    expect(text).not.toContain(KEY_A.slice(0, -4)) // 前缀零残留
    expect(text).not.toContain(KEY_B.slice(0, -4))
  })

  it('策略二（已知值）：注册过的 key 出现在后续自由文本里同样被遮，序列化行里前后缀都不留', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.info('注册两把 key', { apiKey: KEY_A, apiToken: KEY_B })
    logger.warn('LLM 调用失败：' + KEY_A + ' 已退化，备用 ' + KEY_B + ' 亦 401')
    const second = cap.lines()[1]
    expect(second.msg).toContain('sk-****1111')
    expect(second.msg).toContain('sk-****2222')
    const text = cap.all()
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain(KEY_B)
    expect(text).not.toContain(KEY_A.slice(0, -4))
    expect(text).not.toContain(KEY_B.slice(0, -4))
  })

  it('后四位取法 slice(-4)：短值也不得泄漏更多，敏感键下的对象整体 masked、内嵌字符串防御性注册', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.info('短值与怪值', { apiKey: 'ab12', apiToken: 'x', secretNum: 98765432, apiKeyBlob: { deep: KEY_A } })
    const line = cap.lines()[0]
    expect(line.apiKey).toBe('sk-****ab12')
    expect(line.apiToken).toBe('sk-****x')
    expect(line.secretNum).toBe('sk-****5432')
    expect(line.apiKeyBlob).toBe('[masked]')
    expect(cap.all()).not.toContain('98765432') // 数字敏感值只活后四位
    expect(cap.all()).not.toContain(KEY_A) // 对象叶子字符串被防御性注册后全文替换
  })

  it('已知 key 注册表有界：100 把之后 size ≤ 64，新值仍被遮、不外抛（无常积累不无限增长）', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    for (let i = 0; i < 100; i += 1) {
      logger.info('轮换', { apiKey: 'sk-CANARY-' + String(i).padStart(4, '0') + '-tail' })
    }
    expect(logger.knownSecretCount()).toBeLessThanOrEqual(64)
    const last = 'sk-CANARY-0099-tail'
    expect(cap.all()).not.toContain(last.slice(0, -4)) // 最新值在场时被遮
    logger.info('引用旧值不炸', { note: '历史 key sk-CANARY-0000-tail' }) // 逐出后不炸（逐出语义如实：不再遮）
    expect(cap.lines().length).toBe(101)
  })

  it('Q7/§8.2：event rate→warn、auth→error、warn/reason→warn；error 不携响应体', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.event('error', { botId: 'lixiao', kind: 'rate', message: '429 Too Many Requests', fatal: false })
    logger.event('error', { botId: 'lixiao', kind: 'auth', message: '401 密钥失效', fatal: true })
    logger.event('warn', { botId: 'aqin', reason: 'SLOW DOWN' })
    const [a, b, c] = cap.lines()
    expect(a.level).toBe('warn') // 429 风暴 = warn 级信号，不是 error 刷屏
    expect(a.kind).toBe('rate')
    expect(a.botId).toBe('lixiao')
    expect(a.msg).toBe('bot-core error')
    expect(a.message).toBe('429 Too Many Requests') // core 的 B9 兜底消息原样入列，不 widening
    expect(b.level).toBe('error') // 密钥退化 = error
    expect(b.kind).toBe('auth')
    expect(c.level).toBe('warn')
    expect(c.reason).toBe('SLOW DOWN')
    expect('botId' in c).toBe(true)
  })

  it('host 转发形态的 error()：非致命 kind + fatal:false 降为 warn；auth/fatal:true 与普通 error 不外泄级别', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.error('bot-core error', { botId: 'lixiao', kind: 'network', message: 'TLS 握手失败', fatal: false })
    logger.error('bot-core error', { botId: 'lixiao', kind: 'auth', message: '401', fatal: true })
    logger.error('bot lixiao 未能进入 deck', { botId: 'lixiao', reason: 'MAX_BOTS' }) // 无 kind → 保持 error
    const lines = cap.lines()
    expect(lines[0].level).toBe('warn')
    expect(lines[1].level).toBe('error')
    expect(lines[2].level).toBe('error')
  })

  it('R33 纪律：ConfigLoadError.cause 里的 key 绝不出现在任何日志行——cause 只走 summarizeThrown 同一过滤器', () => {
    const FAKE = 'sk-CAUSELEAK-abcdefg-3456'
    const rawCause = new SyntaxError('Unexpected token \'x\', "' + FAKE + '…" is not valid JSON at position 42')
    const err = new ConfigLoadError('unparsable', 'C:\\data\\saigai-bot.config.js', summarizeThrown(rawCause), rawCause)
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    logger.error('FAIL: 配置读取失败（' + err.kind + '）：' + err.message, { err })
    logger.warn('热重载坏读', { err, path: err.path }) // 同一 wrapper 再走一遍：cause 面恒只出摘要
    const text = cap.all()
    expect(text).not.toContain(FAKE)
    expect(text).not.toContain(FAKE.slice(0, -4)) // 前缀零残留——R33 关掉的口子不许隔一层重开
    const line = cap.lines()[0]
    expect(line.err.name).toBe('ConfigLoadError')
    expect(line.err.message).toBe(err.message) // 构造点已净化，逐字透传不再 widening
    expect(line.err.cause).toBe(summarizeThrown(rawCause)) // 'SyntaxError（position 42）'：name + 纯数字定位
    expect(cap.lines()[1].err.cause).toBe(summarizeThrown(rawCause))
    expect(cap.lines()[1].path).toBe(err.path)
    // 带 code 的 cause：label 取 code，同样只加数字——cause 的自由文本面整体封死（name/code/数字之外无一字）
    const coded = Object.assign(new Error('模块炸了 "' + FAKE + '" at position 7'), { code: 'ERR_MODULE_NOT_FOUND' })
    logger.error('模块图失败', { err: new ConfigLoadError('unparsable', 'C:\\cfg.js', summarizeThrown(coded), coded) })
    expect(cap.lines()[2].err.cause).toBe('ERR_MODULE_NOT_FOUND（position 7）')
    expect(cap.all()).not.toContain(FAKE)
    expect(cap.all()).not.toContain('模块炸了')
  })

  it('sink 免疫：注入的 write 抛错时 info/warn/error/event 全部不外抛（Task 1 parked：裸调 + catch 内发射）', () => {
    const boom = () => {
      throw new Error('EPIPE')
    }
    const logger = createLogger({ write: boom, now: () => 7 })
    expect(() => logger.info('a')).not.toThrow()
    expect(() => logger.warn('b', { apiKey: KEY_A })).not.toThrow()
    expect(() => logger.error('c', { err: new Error('x') })).not.toThrow()
    expect(() => logger.event('error', { kind: 'auth', message: '401', fatal: true })).not.toThrow()
    // now 炸也不外抛（ts 归零，行还在——注入的 sink 这次是好的）
    const cap = capture()
    const badNow = createLogger({ write: cap.write, now: () => { throw new Error('时钟坏了') } })
    expect(() => badNow.info('ts 兜底')).not.toThrow()
    expect(cap.lines()[0].ts).toBe(0)
  })

  it('不可序列化输入不外抛：BigInt / 循环引用 / 抛错 getter / 抛错 ownKeys / 深嵌套 / symbol / toString 炸', () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 1 })
    const cyclic = { id: 'lixiao' }
    cyclic.self = cyclic
    const getterBomb = {}
    Object.defineProperty(getterBomb, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter 炸了，还带 ' + KEY_A)
      },
    })
    const trapProxy = new Proxy({ ok: 1 }, { ownKeys() { throw new TypeError('ownKeys trap') } })
    let deep = { leaf: '最深' }
    for (let i = 0; i < 50; i += 1) deep = { nested: deep }
    expect(() => logger.info('BigInt', { big: 10n })).not.toThrow()
    expect(cap.lines()[0].big).toBe('[bigint 10]')
    expect(() => logger.info('循环', cyclic)).not.toThrow()
    expect(cap.lines()[1].self.self).toBe('[circular]')
    expect(() => logger.info('getter 炸', getterBomb)).not.toThrow()
    expect(cap.lines()[2].boom).toBe('[unreadable]')
    expect(cap.all()).not.toContain(KEY_A) // getter 异常文本（含 key）不落任何行
    expect(() => logger.info('ownKeys 炸', trapProxy)).not.toThrow()
    expect(cap.lines()[3].msg).toBe('ownKeys 炸')
    expect(() => logger.info('深嵌套', deep)).not.toThrow()
    expect(JSON.stringify(cap.lines()[4]).length).toBeLessThan(200) // 深度封顶，不烧穿
    expect(() => logger.info('symbol 值', { s: Symbol('敏感描述') })).not.toThrow()
    expect(cap.lines()[5].s).toBe('[symbol]')
    expect(() => logger.info({ toString() { throw new Error('toString 炸') } })).not.toThrow()
    expect(cap.lines()[6].msg).toBe('[unprintable]')
    expect(() => logger.info('fields 是字符串', '不是对象')).not.toThrow()
    expect(() => logger.event(Symbol('type'), () => '不是载荷')).not.toThrow()
    expect(cap.lines()[8].level).toBe('warn')
  })

  it('自定义 redact 钩子：默认脱敏之后追加执行；钩子自己炸不外溢', () => {
    const cap = capture()
    const hook = createLogger({ write: cap.write, now: () => 1, redact: (s) => s.split('小李').join('**') })
    hook.info('bot 小李 发言')
    expect(cap.lines()[0].msg).toBe('bot ** 发言')
    const bomb = createLogger({
      write: cap.write,
      now: () => 1,
      redact: () => {
        throw new Error('钩子炸')
      },
    })
    expect(() => bomb.info('原样')).not.toThrow()
    expect(cap.lines()[1].msg).toBe('原样') // 钩子失败回退默认脱敏结果，行不丢
  })

  it('cli 缺省 logger 已换成 createLogger：run --once 不注入 logger → stdout 收到合法 JSON 行（接线验收）', async () => {
    const raw = {
      name: 'lab-vm',
      serverUrl: 'wss://kuoluosaigai.com',
      provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-static-key', model: 'deepseek-chat' },
      bots: [{ id: 'lixiao', name: '小李', persona: '大三学生', room: 'nebula' }],
    }
    const written = []
    const orig = process.stdout.write
    process.stdout.write = (s) => {
      written.push(String(s))
      return true
    }
    let code = -1
    try {
      code = await main(['run', '--once', '--data-dir', path.join(os.tmpdir(), 'saigai-log-t11-cli')], {
        load: async () => raw,
        acquireLock: () => ({ ok: true, tookOver: true, release: () => {} }),
        createStore: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {}, readOrphans: () => ({}), path: 'state.json' }),
        createHost: () => ({
          boot: async () => {},
          converge: async () => ({}),
          snapshot: () => ({ meta: {}, bots: [] }),
          shutdown: () => {},
        }),
      })
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(0)
    const lines = written.filter((s) => s.trim() !== '').map((s) => JSON.parse(s))
    expect(lines.length).toBeGreaterThanOrEqual(3) // 接管陈旧锁 warn + 已启动 info + 一轮完成 info
    expect(lines.every((l) => typeof l.ts === 'number' && typeof l.level === 'string' && typeof l.msg === 'string')).toBe(true)
    expect(lines.some((l) => l.level === 'warn' && l.msg.indexOf('接管陈旧锁') === 0)).toBe(true)
    expect(lines.some((l) => l.msg.includes('daemon 已启动'))).toBe(true)
    expect(written.join('')).not.toContain('sk-static-key')
  })

  it('控制面 500 留痕（Task 10 parked Minor 1）：snapshot 炸 → 注入 logger 收到一条 warn 常量行，异常/响应内容不回显', async () => {
    const cap = capture()
    const logger = createLogger({ write: cap.write, now: () => 5 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-log-t11-rpc-'))
    const handle = await startControlServer({
      dir,
      pid: 4242,
      startedAt: 1,
      logger,
      snapshot: () => {
        throw new Error('快照内部炸了，还带 ' + KEY_A)
      },
    })
    try {
      const res = await fetch('http://127.0.0.1:' + handle.port + '/status', { headers: { [SECRET_HEADER]: handle.secret } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'snapshot-unavailable' })
      const warns = cap.lines().filter((l) => l.level === 'warn')
      expect(warns.length).toBe(1)
      expect(warns[0].msg).toContain('/status')
      const text = cap.all()
      expect(text).not.toContain('快照内部炸了') // 异常文本零回显
      expect(text).not.toContain(KEY_A)
      expect(text).not.toContain(handle.secret) // secret 也不进日志
    } finally {
      await handle.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('控制面日志器炸不许拦 500 响应（sink 免疫贯穿 rpc 接线）；未注入 logger 时行为逐字节不变', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-log-t11-rpc2-'))
    const boomLogger = {
      warn() {
        throw new Error('logger EPIPE')
      },
    }
    const cases = [{ logger: boomLogger }, {}] // 炸日志器 + 缺省无日志器：两条路都必须回 500 固定体
    for (const extra of cases) {
      const handle = await startControlServer({
        dir,
        pid: 4242,
        startedAt: 1,
        ...extra,
        snapshot: () => {
          throw new Error('快照炸')
        },
      })
      try {
        const res = await fetch('http://127.0.0.1:' + handle.port + '/status', { headers: { [SECRET_HEADER]: handle.secret } })
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'snapshot-unavailable' })
      } finally {
        await handle.close()
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
