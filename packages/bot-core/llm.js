// LlmClient（Task 4 / spec §4、§11）：OpenAI 兼容 chat/completions 客户端。
// 原生 fetch + AbortController，零依赖、纯异步，不依赖 Vue、不 import 其他 bot-core 模块。
//
// 设计钉死（对 Task 7 runner 的契约，改动须同步 runner）：
// - LlmError.kind ∈ auth|rate|server|timeout|network|bad-response，供 runner 分流
//   （auth → 立即停用 bot；rate/server/timeout/network → 本次放弃）。
// - 重试语义：auth/bad-response 立即抛不重试；rate/server/timeout/network sleep 后
//   恰好重试一次，第二次仍败才抛。无指数退避、无流式（YAGNI）。
// - 安全红线 B9/A3：apiKey 只出现在 fetch 的 Authorization 头；LlmError 的 message、
//   自有属性、JSON.stringify 结果不得含 key——detail 只放状态码/err.name 等安全摘要，
//   绝不放 response body 或请求配置。

/** 错误分类：kind ∈ 'auth'|'rate'|'server'|'timeout'|'network'|'bad-response'。message/detail 永不含 apiKey。 */
export class LlmError extends Error {
  constructor(kind, detail = '') {
    super(`LLM 调用失败: ${kind}${detail ? `（${detail}）` : ''}`)
    this.name = 'LlmError'
    this.kind = kind
    this.detail = detail
  }
}

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** HTTP 状态码 → kind；返回 null 表示不属于直接映射（2xx 或其它 4xx 走 bad-response 路径）。 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return null
}

/** 从 2xx 响应解析出 { text, promptTokens, completionTokens }；畸形一律 bad-response。 */
async function parseResponse(res) {
  const kind = classifyStatus(res.status)
  if (kind) throw new LlmError(kind, `HTTP ${res.status}`)
  if (!res.ok) throw new LlmError('bad-response', `HTTP ${res.status}`)
  let data
  try {
    data = await res.json()
  } catch (err) {
    throw new LlmError('bad-response', err && err.name ? String(err.name) : '响应非 JSON')
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('bad-response', 'choices/content 畸形')
  }
  const usage = data?.usage || {}
  return {
    text: content.trim(),
    promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
  }
}

/** 单次请求：AbortController 控超时；fetch 抛出时 AbortError→timeout、其余→network。 */
async function requestOnce({ fetchImpl, url, headers, body, timeoutMs }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body, signal: ac.signal })
    } catch (err) {
      if (err && err.name === 'AbortError') throw new LlmError('timeout', `${timeoutMs}ms`)
      throw new LlmError('network', err && err.name ? String(err.name) : 'unknown')
    }
    return await parseResponse(res)
  } finally {
    clearTimeout(timer) // 成功/失败都撤定时器，不留悬挂 timer
  }
}

/**
 * OpenAI 兼容 chat/completions 调用。
 * provider = { baseUrl, apiKey }；URL = baseUrl 去尾斜杠 + '/chat/completions'。
 * 返回 { text(trim 后), promptTokens, completionTokens }（usage 缺失记 0）。
 */
export async function chatCompletion({
  provider,
  model,
  messages,
  temperature = 0.9,
  timeoutMs = 30000,
  retryDelayMs = 1000,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
}) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  }
  const body = JSON.stringify({ model, temperature, messages })
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs)
    try {
      return await requestOnce({ fetchImpl, url, headers, body, timeoutMs })
    } catch (err) {
      const llmError =
        err instanceof LlmError ? err : new LlmError('network', err && err.name ? String(err.name) : 'unknown')
      if (llmError.kind === 'auth' || llmError.kind === 'bad-response') throw llmError
      lastError = llmError
    }
  }
  throw lastError
}
