// P3c 浏览器适配层：把 Vue 的 reactive 与 localStorage 注入宿主无关的 remote.js。
// 凭证（session token）只在这台浏览器 localStorage 里；组件不得渲染它。
import { reactive } from 'vue'
import { createRemoteStore as createRawStore, DEVICES_KEY } from './remote'

export { DEVICES_KEY }

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  }
}

/** localStorage 在隐私模式/沙箱里可能**访问属性就抛**，不能让它炸掉 App 启动。 */
function safeStorage() {
  try {
    const s = globalThis.localStorage
    s.getItem(DEVICES_KEY)
    return s
  } catch (e) {
    return memoryStorage()
  }
}

/**
 * @param {{ wsUrl?: string, storage?: Storage, WebSocketImpl?: Function, commandTimeoutMs?: number }} [opts]
 * @returns {object} reactive remote store
 */
export function createRemoteStore({
  wsUrl = '',
  storage = safeStorage(),
  WebSocketImpl = globalThis.WebSocket,
  commandTimeoutMs = 8000,
} = {}) {
  return createRawStore({
    wsUrl,
    storage,
    WebSocketImpl,
    reactiveImpl: reactive,
    commandTimeoutMs,
  })
}
