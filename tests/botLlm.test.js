import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatCompletion, LlmError } from 'kuoluosaigai-bot-core'

// Task 4 / spec §11「LlmClient」矩阵：成功解析 / auth 立停 / 429·5xx·timeout·network
// 恰好重试一次 / bad-response 不重试 / usage 兜底 0 / B9 apiKey 零泄漏。
// 零真实网络：fetchImpl 全注入；超时用 vi.useFakeTimers + 尊重 signal abort 的挂起 mock。

const API_KEY = 'sk-TEST-SECRET-42'
const provider = { baseUrl: 'https://api.example.com/v1/', apiKey: API_KEY }

const okBody = {
  choices: [{ message: { content: ' 你好呀 ' } }],
  usage: { prompt_tokens: 120, completion_tokens: 8 },
}

/** 构造一个 Response 形状的对象（只用到 status/ok/json 三个成员）。 */
const res = (status, body, { jsonThrows = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (jsonThrows) throw new SyntaxError('Unexpected token < in JSON')
    return body
  },
})

/** 非超时路径注入的 sleep：立即 resolve，避免真实 1000ms 等待。 */
const noWaitSleep = async () => {}

/** 永不 resolve、只在 signal abort 时以 AbortError 拒绝的 fetch mock（模拟挂起请求）。 */
const hangFetch = () => {
  const signals = []
  const fn = vi.fn((_url, init) => {
    signals.push(init.signal)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  })
  fn.signals = signals
  return fn
}

/** 捕获 promise 拒绝的错误；promise 若意外成功则返回 null。 */
const grab = async (promise) => {
  try {
    await promise
    return null
  } catch (e) {
    return e
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LlmError', () => {
  it('是 Error 子类，kind/detail 为自有属性', () => {
    const e = new LlmError('auth', 'HTTP 401')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(LlmError)
    expect(e.name).toBe('LlmError')
    expect(e.kind).toBe('auth')
  })
})

describe('chatCompletion 成功路径', () => {
  it('成功: POST {baseUrl}/chat/completions，header Authorization: Bearer <key>，body {model,temperature,messages}；返回 trim 后 text 与 usage', async () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
    const fetchImpl = vi.fn(async () => res(200, okBody))
    const out = await chatCompletion({
      provider, model: 'gpt-x', messages, fetchImpl, sleep: noWaitSleep,
    })
    expect(out).toEqual({ text: '你好呀', promptTokens: 120, completionTokens: 8 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-x', temperature: 0.9, messages })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('baseUrl 无尾斜杠同样拼接；自定义 temperature 透传；usage 缺失 → tokens 为 0', async () => {
    const fetchImpl = vi.fn(async () => res(200, { choices: [{ message: { content: 'ok' } }] }))
    const out = await chatCompletion({
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: API_KEY },
      model: 'gpt-x', messages: [], temperature: 0.3, fetchImpl, sleep: noWaitSleep,
    })
    expect(out).toEqual({ text: 'ok', promptTokens: 0, completionTokens: 0 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(JSON.parse(init.body).temperature).toBe(0.3)
  })
})

describe('401/403 → kind=auth，不重试立即抛', () => {
  it.each([401, 403])('HTTP %i → auth，fetchImpl 只被调 1 次，sleep 未被调', async (status) => {
    const fetchImpl = vi.fn(async () => res(status, {}))
    const sleep = vi.fn(noWaitSleep)
    const err = await grab(chatCompletion({
      provider, model: 'm', messages: [], fetchImpl, sleep,
    }))
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('auth')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('429/5xx → sleep(retryDelayMs=1000) 后重试恰好一次', () => {
  it.each([[429, 'rate'], [500, 'server'], [503, 'server']])(
    'HTTP %i 两次都失败 → kind=%s，共 2 次调用，sleep(1000) 恰 1 次',
    async (status, kind) => {
      const fetchImpl = vi.fn(async () => res(status, {}))
      const sleep = vi.fn(noWaitSleep)
      const err = await grab(chatCompletion({
        provider, model: 'm', messages: [], fetchImpl, sleep,
      }))
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe(kind)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledTimes(1)
      expect(sleep).toHaveBeenCalledWith(1000)
    },
  )

  it('429 后重试成功 → 正常返回 text，不抛错', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (++n === 1 ? res(429, {}) : res(200, okBody)))
    const out = await chatCompletion({
      provider, model: 'm', messages: [], fetchImpl, sleep: noWaitSleep,
    })
    expect(out.text).toBe('你好呀')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('网络拒绝 → kind=network，重试恰好一次', () => {
  it('fetch 抛 TypeError → 重试 1 次仍失败 → network（共 2 次调用）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const sleep = vi.fn(noWaitSleep)
    const err = await grab(chatCompletion({
      provider, model: 'm', messages: [], fetchImpl, sleep,
    }))
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('network')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})

describe('超时 → AbortController 触发，重试恰好一次', () => {
  it('超时: AbortController 30000ms 触发 → 重试 1 次 → kind=timeout；断言 fetch 收到 signal', async () => {
    vi.useFakeTimers()
    const fetchImpl = hangFetch()
    const p = chatCompletion({ provider, model: 'm', messages: [], fetchImpl })
    p.catch(() => {}) // 防止 runAllTimersAsync 期间出现未处理的 rejection
    await vi.runAllTimersAsync()
    const err = await grab(p)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('timeout')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 两次请求都收到 AbortSignal，且都被 30000ms 定时器真实 abort（默认 timeoutMs 生效）
    expect(fetchImpl.signals).toHaveLength(2)
    for (const signal of fetchImpl.signals) {
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(true)
    }
  })

  it('自定义 timeoutMs + retryDelayMs：短超时同样重试一次，sleep 收到自定义延迟', async () => {
    vi.useFakeTimers()
    const fetchImpl = hangFetch()
    const p = chatCompletion({
      provider, model: 'm', messages: [], fetchImpl, timeoutMs: 500, retryDelayMs: 200,
    })
    p.catch(() => {})
    await vi.runAllTimersAsync()
    const err = await grab(p)
    expect(err.kind).toBe('timeout')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.signals.every((s) => s.aborted)).toBe(true)
  })
})

describe('200 但响应畸形 → kind=bad-response，不重试', () => {
  const cases = [
    ['choices 缺失', res(200, { usage: { prompt_tokens: 1 } })],
    ['content 空串', res(200, { choices: [{ message: { content: '' } }] })],
    ['content 非字符串', res(200, { choices: [{ message: { content: 42 } }] })],
    ['非 JSON', res(200, null, { jsonThrows: true })],
    ['其它非 2xx（400）', res(400, {})],
  ]
  it.each(cases)('%s → bad-response，fetchImpl 只被调 1 次', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response)
    const sleep = vi.fn(noWaitSleep)
    const err = await grab(chatCompletion({
      provider, model: 'm', messages: [], fetchImpl, sleep,
    }))
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad-response')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('B9: apiKey 零泄漏', () => {
  it('以上所有 kind 的错误：message + 自有属性 + JSON.stringify(error) 均不含 apiKey 子串', async () => {
    const base = { provider, model: 'm', messages: [] }
    const errs = []
    const collect = async (extra) => {
      const e = await grab(chatCompletion({ ...base, sleep: noWaitSleep, ...extra }))
      errs.push(e ?? new Error('场景未抛错'))
    }
    await collect({ fetchImpl: async () => res(401, {}) })
    await collect({ fetchImpl: async () => res(403, {}) })
    await collect({ fetchImpl: async () => res(429, {}) })
    await collect({ fetchImpl: async () => res(500, {}) })
    await collect({ fetchImpl: async () => res(400, {}) })
    // 恶意/意外把 key 带进底层 error message：实现只许提取 err.name，不得转发原文
    await collect({ fetchImpl: async () => { throw new TypeError(`fetch failed: ${API_KEY}`) } })
    await collect({ fetchImpl: async () => res(200, null, { jsonThrows: true }) })
    await collect({ fetchImpl: async () => res(200, { choices: [] }) })
    // timeout 场景（fake timers）
    vi.useFakeTimers()
    const fetchImpl = hangFetch()
    const p = chatCompletion({ ...base, fetchImpl })
    p.catch(() => {})
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    errs.push(await grab(p) ?? new Error('timeout 场景未抛错'))

    const kinds = new Set(errs.map((e) => e && e.kind))
    for (const k of ['auth', 'rate', 'server', 'timeout', 'network', 'bad-response']) {
      expect(kinds.has(k)).toBe(true)
    }
    for (const e of errs) {
      expect(e).toBeInstanceOf(LlmError)
      expect(e.message).not.toContain(API_KEY)
      expect(String(e.stack)).not.toContain(API_KEY)
      expect(JSON.stringify(e)).not.toContain(API_KEY)
      expect(JSON.stringify({ ...e })).not.toContain(API_KEY)
      expect(Object.values(e).map(String).join('|')).not.toContain(API_KEY)
    }
  })
})
