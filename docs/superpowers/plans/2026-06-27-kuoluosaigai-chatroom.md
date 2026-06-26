# 真聊天室 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1 占位聊天入口升级为真实匿名聊天室——Node + `ws` 自托管后端 + `useChat` 组合式 + `ChatRoom` 全屏终端 UI，随机昵称、单全局房间、频道徽章。

**Architecture:** 后端独立 `server/`（Node + `ws`，无持久化、单房间、限速+截断、JSON 帧协议），前端新增 `useChat` 组合式封装传输/状态、`ChatRoom.vue` 终端风三段式布局（顶栏/消息流/输入栏），`App.vue` 用 `ChatRoom` 替换 `ChatPlaceholder`。WS 端点经 `VUE_APP_WS_URL` 注入，未配置则离线降级。

**Tech Stack:** Vue 3（Options + setup 混用，匹配现有风格）、`ws` ^8.18（后端）、vitest ^4.1.9（前后端各自配置）、jsdom（前端）/ node（后端）。

## Global Constraints

- 协议帧均为 JSON，`type` 字段：`assign | join | leave | message | presence | rate | error`。
- 客户端发：`{type:'message', text, badge}`（`badge` = 客户端当前频道 `prefix`，服务端原样透传不校验）。
- 服务端广播：`assign {type,nick}`、`join {type,nick,ts}`、`leave {type,nick,ts}`、`message {type,nick,badge,text,ts}`、`presence {type,online}`、`rate {type,ts}`。
- 昵称格式 `ANON-XXXX`，4 位取自 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（剔除 O/I/0/1）。
- 消息文本截断 ≤ 280 字符；限速每客户端 ≤ 10 条/分钟（60s 滑动窗口），超限回 `rate` 帧且不广播。
- 断线重连退避 `1000 → 2000 → 5000` ms 封顶。
- `VUE_APP_WS_URL` 未配置 → ChatRoom 离线降级，`useChat.connect()` 不发起新连接。
- `prefers-reduced-motion`：ChatRoom 无进入动画直显（传输层重连不受影响）。
- 后端独立 `server/package.json`（`type:module`、`ws` + `vitest`），根 `package.json` 不混入 server 依赖；根 `vitest.config.js` 排除 `server/**`；根 eslint `ignorePatterns` 含 `server/`。
- 前端测试 `npm test`（根），后端测试 `cd server && npm test`（先 `cd server && npm install`）。

---

### Task 1: 后端 chat server（Node + ws）

**Files:**
- Create: `server/package.json`
- Create: `server/vitest.config.js`
- Create: `server/index.js`
- Create: `server/start.js`
- Create: `server/index.test.js`
- Modify: `vitest.config.js`（根，排除 `server/**`）

**Interfaces:**
- Consumes: 无（独立子系统）
- Produces: `server/index.js` 导出 `createServer()` → `{ start(port=0): Promise<number>, close(): Promise<void> }`。`start` 监听并返回实际端口；`close` 关闭所有连接与 http server。帧协议见 Global Constraints。

- [ ] **Step 1: Scaffold server package + configs**

Create `server/package.json`:
```json
{
  "name": "kuoluosaigai-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node start.js",
    "test": "vitest run"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "vitest": "^4.1.9"
  }
}
```

Create `server/vitest.config.js`:
```js
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node' },
})
```

Modify root `vitest.config.js` to exclude `server/**` so the frontend run does not pick up server tests:
```js
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['tests/setup.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'server/**'],
  },
})
```

- [ ] **Step 2: Write the failing tests**

Create `server/index.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createServer } from './index.js'

describe('chat server', () => {
  let server, url

  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  function connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(url)
      const received = []
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
      ws.on('open', () => resolve({ ws, received }))
    })
  }

  function nextFrame(received, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame timeout')), timeout)
      const check = () => {
        if (received.length) {
          clearTimeout(timer)
          resolve(received.shift())
        } else {
          setTimeout(check, 5)
        }
      }
      check()
    })
  }

  async function boot() {
    server = createServer()
    const port = await server.start(0)
    url = `ws://localhost:${port}`
  }

  it('assigns a nick and presence on connect', async () => {
    await boot()
    const { ws, received } = await connect()
    const assign = await nextFrame(received)
    expect(assign.type).toBe('assign')
    expect(assign.nick).toMatch(/^ANON-[A-Z2-9]{4}$/)
    const presence = await nextFrame(received)
    expect(presence).toEqual({ type: 'presence', online: 1 })
    ws.close()
  })

  it('broadcasts messages with badge and truncates text over 280 chars', async () => {
    await boot()
    const { ws, received } = await connect()
    await nextFrame(received) // assign
    await nextFrame(received) // presence
    ws.send(JSON.stringify({ type: 'message', text: 'a'.repeat(300), badge: 'SETSUBUN' }))
    const msg = await nextFrame(received)
    expect(msg.type).toBe('message')
    expect(msg.badge).toBe('SETSUBUN')
    expect(msg.text).toHaveLength(280)
    expect(msg.nick).toMatch(/^ANON-/)
    expect(typeof msg.ts).toBe('number')
    ws.close()
  })

  it('rate-limits after 10 messages/minute and suppresses broadcast', async () => {
    await boot()
    const { ws, received } = await connect()
    await nextFrame(received) // assign
    await nextFrame(received) // presence
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'message', text: `m${i}`, badge: '' }))
      const f = await nextFrame(received)
      expect(f.type).toBe('message')
    }
    ws.send(JSON.stringify({ type: 'message', text: 'over', badge: '' }))
    const frame = await nextFrame(received)
    expect(frame.type).toBe('rate')
    ws.close()
  })

  it('broadcasts join/leave and presence to other clients', async () => {
    await boot()
    const a = await connect()
    await nextFrame(a.received) // assign
    await nextFrame(a.received) // presence(1)
    const b = await connect()
    const join = await nextFrame(a.received)
    expect(join.type).toBe('join')
    expect(join.nick).toMatch(/^ANON-/)
    const presence2 = await nextFrame(a.received)
    expect(presence2).toEqual({ type: 'presence', online: 2 })
    await nextFrame(b.received) // b assign
    await nextFrame(b.received) // b presence(2)
    b.ws.close()
    const leave = await nextFrame(a.received)
    expect(leave.type).toBe('leave')
    const presence1 = await nextFrame(a.received)
    expect(presence1).toEqual({ type: 'presence', online: 1 })
    a.ws.close()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npm install && npm test`
Expected: FAIL — `Cannot find module './index.js'`（尚未实现）。

- [ ] **Step 4: Implement the server**

Create `server/index.js`:
```js
import http from 'node:http'
import { WebSocketServer } from 'ws'

const NICK_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 剔除 O/I/0/1
const MAX_LEN = 280
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000

function genNick() {
  let s = 'ANON-'
  for (let i = 0; i < 4; i++) {
    s += NICK_CHARS[Math.floor(Math.random() * NICK_CHARS.length)]
  }
  return s
}

function now() {
  return Date.now()
}

export function createServer() {
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })
  const clients = new Map() // ws -> { nick, times: [] }

  function send(ws, frame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  function broadcast(frame, except = null) {
    const data = JSON.stringify(frame)
    for (const ws of clients.keys()) {
      if (ws === except || ws.readyState !== ws.OPEN) continue
      ws.send(data)
    }
  }

  function broadcastPresence() {
    broadcast({ type: 'presence', online: clients.size })
  }

  function rateLimited(info) {
    const t = now()
    info.times = info.times.filter((x) => t - x < RATE_WINDOW)
    if (info.times.length >= RATE_LIMIT) return true
    info.times.push(t)
    return false
  }

  wss.on('connection', (ws) => {
    const nick = genNick()
    const info = { nick, times: [] }
    clients.set(ws, info)

    send(ws, { type: 'assign', nick })
    broadcast({ type: 'join', nick, ts: now() }, ws)
    broadcastPresence()

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        send(ws, { type: 'error', msg: 'bad frame' })
        return
      }
      if (frame.type !== 'message') return
      if (rateLimited(info)) {
        send(ws, { type: 'rate', ts: now() })
        return
      }
      const text = String(frame.text || '').slice(0, MAX_LEN)
      broadcast({
        type: 'message',
        nick,
        badge: String(frame.badge || ''),
        text,
        ts: now(),
      })
    })

    ws.on('close', () => {
      if (!clients.delete(ws)) return
      broadcast({ type: 'leave', nick, ts: now() })
      broadcastPresence()
    })
  })

  return {
    start(port = 0) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => resolve(httpServer.address().port))
      })
    },
    close() {
      return new Promise((resolve) => {
        for (const ws of clients.keys()) ws.close()
        clients.clear()
        wss.close(() => httpServer.close(() => resolve()))
      })
    },
  }
}
```

Create `server/start.js`:
```js
import { createServer } from './index.js'

const port = Number(process.env.PORT) || 8080
createServer()
  .start(port)
  .then((p) => console.log(`kuoluosaigai chat server listening on ws://localhost:${p}`))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Confirm frontend suite still green and unaffected**

Run: `npm test`（根目录）
Expected: PASS — 前端测试全绿，server/ 被排除未被执行。

- [ ] **Step 7: Commit**

```bash
git add server/ vitest.config.js
git commit -m "feat(server): Node+ws 聊天服务（昵称/广播/限速/截断/在线计数）"
```

---

### Task 2: `useChat` 组合式（传输 + 状态）

**Files:**
- Create: `src/composables/useChat.js`
- Test: `tests/useChat.test.js`

**Interfaces:**
- Consumes: 全局 `WebSocket` 构造器（浏览器/jsdom）；URL 字符串
- Produces: `useChat(url, badge='')` → `{ status, nick, messages, online, send(text), connect(), disconnect() }`。`status/nick/messages/online` 为 `ref`；`messages` 元素为服务端帧对象（`{type, nick?, badge?, text?, ts?}`）。`send(text)` 发 `{type:'message', text, badge}`。内部 `onBeforeUnmount(disconnect)`。

- [ ] **Step 1: Write the failing tests**

Create `tests/useChat.test.js`:
```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useChat } from '../src/composables/useChat'

class MockSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    MockSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      if (this.onopen) this.onopen()
    }, 0)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    if (this.onclose) this.onclose()
  }
  emit(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }
}
MockSocket.instances = []

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

function mountChat(url = 'ws://test', badge = 'SETSUBUN') {
  const Comp = defineComponent({
    setup() {
      const c = useChat(url, badge)
      return { c }
    },
    render() {
      return h('div')
    },
  })
  return mount(Comp)
}

describe('useChat', () => {
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
  })
  afterEach(() => {
    vi.useRealTimers()
    delete global.WebSocket
  })

  it('connects, goes open, and stores assigned nick', async () => {
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    expect(w.vm.c.status.value).toBe('open')
    MockSocket.instances[0].emit({ type: 'assign', nick: 'ANON-7K2' })
    expect(w.vm.c.nick.value).toBe('ANON-7K2')
  })

  it('updates online and appends message/join/leave/rate frames', async () => {
    const w = mountChat()
    w.vm.c.connect()
    await flush()
    const s = MockSocket.instances[0]
    s.emit({ type: 'presence', online: 3 })
    expect(w.vm.c.online.value).toBe(3)
    s.emit({ type: 'message', nick: 'X', badge: 'SETSUBUN', text: 'hi', ts: 1 })
    s.emit({ type: 'join', nick: 'Y', ts: 2 })
    s.emit({ type: 'rate', ts: 3 })
    s.emit({ type: 'leave', nick: 'Y', ts: 4 })
    expect(w.vm.c.messages.value).toHaveLength(4)
  })

  it('send posts a message frame with badge only when open', async () => {
    const w = mountChat()
    w.vm.c.send('no') // closed -> no socket
    expect(MockSocket.instances).toHaveLength(0)
    w.vm.c.connect()
    await flush()
    const s = MockSocket.instances[0]
    w.vm.c.send('hello')
    expect(s.sent).toHaveLength(1)
    expect(JSON.parse(s.sent[0])).toEqual({ type: 'message', text: 'hello', badge: 'SETSUBUN' })
  })

  it('reconnects with backoff after an unexpected close', async () => {
    vi.useFakeTimers()
    const w = mountChat()
    w.vm.c.connect()
    await vi.advanceTimersByTimeAsync(0) // flush open
    expect(MockSocket.instances).toHaveLength(1)
    MockSocket.instances[0].close() // schedules reconnect(1000ms)
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockSocket.instances).toHaveLength(2)
    w.unmount()
  })

  it('disconnect on unmount closes the socket and prevents further reconnects', async () => {
    vi.useFakeTimers()
    const w = mountChat()
    w.vm.c.connect()
    await vi.advanceTimersByTimeAsync(0)
    const s = MockSocket.instances[0]
    const closeSpy = vi.spyOn(s, 'close')
    w.unmount()
    expect(closeSpy).toHaveBeenCalled()
    const count = MockSocket.instances.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(MockSocket.instances.length).toBe(count)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/useChat.test.js`
Expected: FAIL — `Cannot find module '../src/composables/useChat.js'`。

- [ ] **Step 3: Implement the composable**

Create `src/composables/useChat.js`:
```js
import { ref, onBeforeUnmount } from 'vue'

const BACKOFF = [1000, 2000, 5000]

export function useChat(url, badge = '') {
  const status = ref('closed')
  const nick = ref(null)
  const messages = ref([])
  const online = ref(0)
  let ws = null
  let retries = 0
  let retryTimer = null
  let closedByUser = false

  function connect() {
    if (!url) {
      status.value = 'closed'
      return
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
    closedByUser = false
    status.value = 'connecting'
    ws = new WebSocket(url)
    ws.onopen = () => {
      retries = 0
      status.value = 'open'
    }
    ws.onmessage = (ev) => {
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (frame.type) {
        case 'assign':
          nick.value = frame.nick
          break
        case 'presence':
          online.value = frame.online
          break
        case 'message':
        case 'join':
        case 'leave':
        case 'rate':
          messages.value.push(frame)
          break
      }
    }
    ws.onclose = () => {
      status.value = 'closed'
      ws = null
      if (closedByUser) return
      const delay = BACKOFF[Math.min(retries, BACKOFF.length - 1)]
      retries += 1
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => {}
  }

  function send(text) {
    if (status.value !== 'open' || !ws) return
    ws.send(JSON.stringify({ type: 'message', text, badge }))
  }

  function disconnect() {
    closedByUser = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        // already closed
      }
      ws = null
    }
    status.value = 'closed'
  }

  onBeforeUnmount(disconnect)

  return { status, nick, messages, online, send, connect, disconnect }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/useChat.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useChat.js tests/useChat.test.js
git commit -m "feat(chat): useChat 组合式（连接/昵称/消息/在线数/重连）"
```

---

### Task 3: `ChatRoom.vue` 终端风全屏 UI

**Files:**
- Create: `src/components/ChatRoom.vue`
- Test: `tests/ChatRoom.test.js`

**Interfaces:**
- Consumes: `useChat(url, badge)`（Task 2）；props `url: String`、`channel: Object`（取 `channel.prefix` 做 `badge`）；全局 `WebSocket`
- Produces: 组件 `ChatRoom`，props `{ url, channel }`，emits `close`。挂载即 `connect()`，卸载由 `useChat` 内部 `onBeforeUnmount` 断开。布局 A（顶栏/消息流/输入栏），Esc 或 ✕ 按钮 emit `close`。

- [ ] **Step 1: Write the failing tests**

Create `tests/ChatRoom.test.js`:
```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatRoom from '../src/components/ChatRoom.vue'
import { CHANNELS } from '../src/theme/channels'

class MockSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    MockSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      if (this.onopen) this.onopen()
    }, 0)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    if (this.onclose) this.onclose()
  }
  emit(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }
}
MockSocket.instances = []

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ChatRoom', () => {
  let channel
  beforeEach(() => {
    MockSocket.instances = []
    global.WebSocket = MockSocket
    channel = CHANNELS.find((c) => c.prefix === 'SETSUBUN')
  })
  afterEach(() => {
    delete global.WebSocket
  })

  it('shows offline copy and does not connect when url is empty', () => {
    const w = mount(ChatRoom, { props: { url: '', channel } })
    expect(w.text()).toContain('channel offline')
    expect(MockSocket.instances).toHaveLength(0)
  })

  it('renders connected status, online count, and messages with badge', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    expect(w.text()).toContain('connected')
    const s = MockSocket.instances[0]
    s.emit({ type: 'presence', online: 5 })
    s.emit({ type: 'message', nick: 'ANON-7K2', badge: 'SETSUBUN', text: 'hello world', ts: Date.now() })
    await w.vm.$nextTick()
    expect(w.text()).toContain('hello world')
    expect(w.text()).toContain('5 online')
    expect(w.text()).toContain('SETSUBUN')
  })

  it('submits on enter, sends a message frame with badge, and clears the field', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    const s = MockSocket.instances[0]
    await w.find('input').setValue('hi there')
    await w.find('form').trigger('submit')
    expect(s.sent).toHaveLength(1)
    const sent = JSON.parse(s.sent[0])
    expect(sent.type).toBe('message')
    expect(sent.text).toBe('hi there')
    expect(sent.badge).toBe('SETSUBUN')
    expect(w.find('input').element.value).toBe('')
  })

  it('does not send empty input', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    await w.find('input').setValue('   ')
    await w.find('form').trigger('submit')
    expect(MockSocket.instances[0].sent).toHaveLength(0)
  })

  it('emits close on close button and on Escape', async () => {
    const w = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    await w.find('.chat__close').trigger('click')
    expect(w.emitted('close')).toBeTruthy()

    const w2 = mount(ChatRoom, { props: { url: 'ws://x', channel } })
    await flush()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w2.emitted('close')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ChatRoom.test.js`
Expected: FAIL — `Cannot find module '../src/components/ChatRoom.vue'`。

- [ ] **Step 3: Implement the component**

Create `src/components/ChatRoom.vue`:
```html
<template>
  <div class="chat">
    <div class="chat__top">
      <span class="chat__chan">● CHANNEL // GLOBAL</span>
      <span class="chat__meta">{{ online }} online · {{ statusLabel }}</span>
      <button class="chat__close" @click="$emit('close')">✕</button>
    </div>

    <div v-if="!url" class="chat__offline">频道离线 · channel offline</div>

    <template v-else>
      <div ref="listEl" class="chat__msgs">
        <div v-for="(m, i) in messages" :key="i" class="chat__row">
          <span class="chat__time">{{ fmt(m.ts) }}</span>
          <template v-if="m.type === 'message'">
            <span v-if="m.badge" class="chat__badge">{{ m.badge }}</span>
            <span class="chat__nick">{{ m.nick }}</span>
            <span class="chat__body"> &gt; {{ m.text }}</span>
          </template>
          <span v-else class="chat__sys">{{ sysText(m) }}</span>
        </div>
      </div>
      <form class="chat__input" @submit.prevent="onSubmit">
        <span class="chat__prompt">&gt;</span>
        <input
          v-model="draft"
          class="chat__field"
          :disabled="status !== 'open'"
          :placeholder="status === 'open' ? '' : 'offline'"
        />
      </form>
    </template>
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'

function pad(n) {
  return String(n).padStart(2, '0')
}

export default {
  name: 'ChatRoom',
  props: {
    url: { type: String, default: '' },
    channel: { type: Object, default: null },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const badge = props.channel?.prefix || ''
    const chat = useChat(props.url, badge)
    const draft = ref('')
    const listEl = ref(null)

    const statusLabel = computed(() => {
      if (!props.url) return 'offline'
      return { connecting: 'connecting…', open: 'connected', closed: 'offline' }[chat.status.value] || 'offline'
    })

    function fmt(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function sysText(m) {
      if (m.type === 'join') return `${m.nick} joined`
      if (m.type === 'leave') return `${m.nick} left`
      if (m.type === 'rate') return 'rate limit — slow down'
      return ''
    }

    function onSubmit() {
      const text = draft.value.trim()
      if (!text || chat.status.value !== 'open') return
      chat.send(text)
      draft.value = ''
    }

    function onKey(e) {
      if (e.key === 'Escape') emit('close')
    }

    function scrollToBottom() {
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    }

    onMounted(() => {
      chat.connect()
      window.addEventListener('keydown', onKey)
      nextTick(scrollToBottom)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey)
    })
    watch(
      () => chat.messages.value.length,
      async () => {
        await nextTick()
        scrollToBottom()
      }
    )

    return {
      status: chat.status,
      nick: chat.nick,
      messages: chat.messages,
      online: chat.online,
      draft,
      listEl,
      statusLabel,
      fmt,
      sysText,
      onSubmit,
    }
  },
}
</script>

<style scoped>
.chat {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--app-bg, #0a0e0a);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  display: flex;
  flex-direction: column;
}
.chat__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #1f2a1f;
  font-size: 12px;
  letter-spacing: 1px;
}
.chat__meta {
  margin-left: auto;
  margin-right: 12px;
  opacity: 0.8;
}
.chat__close {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  cursor: pointer;
  padding: 2px 8px;
}
.chat__msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.6;
}
.chat__row {
  margin-bottom: 4px;
  word-break: break-word;
}
.chat__time {
  opacity: 0.4;
  margin-right: 8px;
}
.chat__badge {
  display: inline-block;
  border: 1px solid var(--app-color, #39ff14);
  padding: 0 4px;
  font-size: 10px;
  margin-right: 6px;
  opacity: 0.85;
}
.chat__nick {
  color: #7cfc7c;
}
.chat__sys {
  opacity: 0.5;
  font-style: italic;
}
.chat__offline {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  letter-spacing: 2px;
}
.chat__input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #1f2a1f;
}
.chat__prompt {
  opacity: 0.6;
}
.chat__field {
  flex: 1;
  background: #061006;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 13px;
  padding: 6px 10px;
  outline: none;
}
.chat__field:disabled {
  opacity: 0.4;
}
</style>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/ChatRoom.test.js`
Expected: PASS — 5 tests pass。

- [ ] **Step 5: Run the full frontend suite**

Run: `npm test`
Expected: PASS — 前端全绿（含 useChat、ChatRoom 及既有测试）。

- [ ] **Step 6: Commit**

```bash
git add src/components/ChatRoom.vue tests/ChatRoom.test.js
git commit -m "feat(chat): ChatRoom 终端风全屏 UI（顶栏/消息流/输入/Esc 关闭）"
```

---

### Task 4: App 接入 + 退役 ChatPlaceholder + 环境配置

**Files:**
- Modify: `src/App.vue`
- Modify: `tests/App.test.js`
- Delete: `src/components/ChatPlaceholder.vue`
- Delete: `tests/ChatPlaceholder.test.js`
- Create: `.env.example`
- Create: `.env.local`
- Modify: `package.json`（eslintConfig 加 `ignorePatterns`）

**Interfaces:**
- Consumes: `ChatRoom`（Task 3）、`process.env.VUE_APP_WS_URL`（vue-cli 注入）
- Produces: App 渲染 `<ChatRoom v-if="chatOpen" :url="wsUrl" :channel="channel" @close="closeChat" />`；`ChannelShell @enter="openChat"`；`wsUrl = process.env.VUE_APP_WS_URL || ''`。ChatPlaceholder 完全移除。

- [ ] **Step 1: Update App tests (failing first)**

Replace the entire contents of `tests/App.test.js` with:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { CHANNELS } from '../src/theme/channels'

describe('App', () => {
  beforeEach(() => sessionStorage.clear())

  const stubs = {
    'a-config-provider': { template: '<div><slot /></div>' },
    BootSequence: { template: '<div class="boot-stub" @click="$emit(\'ready\')" />', emits: ['ready'] },
    ScanlineWipe: { template: '<div class="wipe-stub" @click="$emit(\'done\')" />', emits: ['done'] },
    ChannelShell: true,
    ChatRoom: true,
  }

  it('starts in boot phase with only BootSequence mounted', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    expect(wrapper.find('.wipe-stub').exists()).toBe(false)
  })

  it('enters wiping on ready: mounts ScanlineWipe, keeps boot, mounts shell', async () => {
    const wrapper = mount(App, { global: { stubs } })
    await wrapper.find('.boot-stub').trigger('click')
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    expect(wrapper.find('.wipe-stub').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('enters shell on wipe done: unmounts boot and wipe, keeps shell', async () => {
    const wrapper = mount(App, { global: { stubs } })
    await wrapper.find('.boot-stub').trigger('click')
    await wrapper.find('.wipe-stub').trigger('click')
    expect(wrapper.find('.boot-stub').exists()).toBe(false)
    expect(wrapper.find('.wipe-stub').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('skips wipe under reduced motion: ready goes straight to shell', async () => {
    const real = window.matchMedia
    window.matchMedia = () => ({
      matches: true, media: '', onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false },
    })
    try {
      const wrapper = mount(App, { global: { stubs } })
      await wrapper.find('.boot-stub').trigger('click')
      expect(wrapper.find('.wipe-stub').exists()).toBe(false)
      expect(wrapper.find('.boot-stub').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
    } finally {
      window.matchMedia = real
    }
  })

  it('falls back to shell via safety timeout if wipe animationend never fires', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(App, { global: { stubs } })
      await wrapper.find('.boot-stub').trigger('click')
      expect(wrapper.find('.wipe-stub').exists()).toBe(true)
      vi.advanceTimersByTime(800)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wipe-stub').exists()).toBe(false)
      expect(wrapper.find('.boot-stub').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('picks a channel on creation', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.vm.channel).toBeTruthy()
    expect(wrapper.vm.channel.freq).toMatch(/^\d{4}$/)
  })

  it('opens ChatRoom on ChannelShell enter and closes on chat close', async () => {
    const enterStubs = {
      'a-config-provider': { template: '<div><slot /></div>' },
      BootSequence: true,
      ScanlineWipe: true,
      ChannelShell: { name: 'ChannelShell', template: '<div class="shell-stub" @click="$emit(\'enter\')" />', emits: ['enter', 'reshuffle'] },
      ChatRoom: { name: 'ChatRoom', template: '<div class="chat-stub" @click="$emit(\'close\')" />', emits: ['close'] },
    }
    const wrapper = mount(App, { global: { stubs: enterStubs } })
    wrapper.vm.onReady()
    wrapper.vm.onWipeDone()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.shell-stub').exists()).toBe(true)
    expect(wrapper.find('.chat-stub').exists()).toBe(false)
    await wrapper.find('.shell-stub').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.chat-stub').exists()).toBe(true)
    await wrapper.find('.chat-stub').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.chat-stub').exists()).toBe(false)
  })
})

describe('App channel theming', () => {
  beforeEach(() => sessionStorage.clear())

  it('sets --app-color on documentElement to the picked channel color', () => {
    const magenta = CHANNELS.find((c) => c.prefix === 'MAGENTA')
    sessionStorage.setItem('kuoluosaigai:channel', magenta.freq)
    mount(App, {
      global: {
        stubs: {
          'a-config-provider': { template: '<div><slot /></div>' },
          BootSequence: true,
          ChannelShell: true,
          ChatRoom: true,
        },
      },
    })
    expect(document.documentElement.style.getPropertyValue('--app-color')).toBe(magenta.color)
    expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe(magenta.glow)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/App.test.js`
Expected: FAIL — App 仍渲染 `ChatPlaceholder`（未注册 `ChatRoom`），新 `opens ChatRoom` 用例找不到 `.chat-stub`。

- [ ] **Step 3: Wire ChatRoom into App**

Modify `src/App.vue`:

In the template, replace the `ChatPlaceholder` line:
```
      <ChatPlaceholder :open="placeholderOpen" @close="placeholderOpen = false" />
```
with:
```
      <ChatRoom v-if="chatOpen" :url="wsUrl" :channel="channel" @close="closeChat" />
```

In the `<script>`, replace the import line `import ChatPlaceholder from './components/ChatPlaceholder.vue'` with:
```js
import ChatRoom from './components/ChatRoom.vue'
```

In `components`, replace `ChatPlaceholder,` with `ChatRoom,`.

In `data()`, replace `placeholderOpen: false,` with:
```js
      chatOpen: false,
      wsUrl: process.env.VUE_APP_WS_URL || '',
```

In `methods`, replace the `openPlaceholder()` method:
```js
    openPlaceholder() {
      this.placeholderOpen = true
    },
```
with:
```js
    openChat() {
      this.chatOpen = true
    },
    closeChat() {
      this.chatOpen = false
    },
```

In the template, change `<ChannelShell ... @enter="openPlaceholder">` to `@enter="openChat"`.

- [ ] **Step 4: Delete ChatPlaceholder**

```bash
git rm src/components/ChatPlaceholder.vue tests/ChatPlaceholder.test.js
```

- [ ] **Step 5: Add env config + eslint ignore**

Create `.env.example` (committed template):
```
VUE_APP_WS_URL=ws://localhost:8080
```

Create `.env.local` (dev, gitignored — root `.gitignore` already ignores `.env.local`):
```
VUE_APP_WS_URL=ws://localhost:8080
```

In `package.json`, add `ignorePatterns` to the `eslintConfig` object so the frontend linter skips the server directory:
```json
  "eslintConfig": {
    "root": true,
    "env": { "node": true },
    "ignorePatterns": ["server/"],
    "extends": ["plugin:vue/vue3-essential", "eslint:recommended"],
    "parserOptions": { "parser": "@babel/eslint-parser" },
    "rules": {}
  },
```

- [ ] **Step 6: Run App tests to verify they pass**

Run: `npm test -- tests/App.test.js`
Expected: PASS — 8 tests（7 既有相位/频道 + 1 新 openChat）。

- [ ] **Step 7: Run the full frontend + server suites**

Run: `npm test && cd server && npm test`
Expected: PASS — 前端全绿，后端 4 绿。

- [ ] **Step 8: Lint check**

Run: `npx eslint src/ tests/`
Expected: 无错误（`server/` 被忽略）。

- [ ] **Step 9: Commit**

```bash
git add src/App.vue tests/App.test.js .env.example package.json
git commit -m "feat(app): 接入 ChatRoom、退役 ChatPlaceholder、VUE_APP_WS_URL 配置"
```

注：`.env.local` 已被根 `.gitignore` 忽略（`/.env.local`、`.env.*.local`），仅本地开发用，不提交；`.env.example` 作为模板提交。

---

## Self-Review Notes

- **Spec coverage:** §2 目录 → 4 task 文件全覆盖；§3 后端协议/昵称/限速/截断/在线计数 → Task 1；§4 useChat 接口/重连退避 → Task 2（`BACKOFF=[1000,2000,5000]` 与 spec 一致）；§5 ChatRoom 布局 A/徽章/Esc/✕/auto-scroll/reduced-motion → Task 3；§6 部署/env/离线降级/eslint ignore → Task 4；§7 错误降级（无 url 离线、断线重连、rate 提示、截断、reduced-motion）→ Task 2/3/4；§8 测试 → 4 task 各含完整测试；§9 范围边界未越界（无多房间/持久化/富媒体/登录/徽章防伪/ChannelShell 顶栏改真值）。
- **Placeholder scan:** 无 TBD/TODO；每步含完整代码与确切命令。
- **类型/命名一致:** `createServer()` 返回 `{start, close}`（Task 1 定义，Task 1 测试消费）；`useChat(url, badge)` 返回 `{status, nick, messages, online, send, connect, disconnect}`（Task 2 定义，Task 3 ChatRoom 消费 `chat.status/messages/online/send/connect`，Task 3 不暴露 `connect/disconnect` 给模板但 `onMounted` 调 `chat.connect()`）；帧 `type` 常量在 Task 1（服务端）与 Task 2（客户端 onmessage switch）一致；`badge` = `channel.prefix`（Task 3 取值、Task 4 传 `:channel`）一致；App 方法 `openChat/closeChat/wsUrl/chatOpen`（Task 4 定义，测试消费）一致。
- **测试环境分离:** 后端 `server/vitest.config.js`（node）独立，根 `vitest.config.js` `exclude server/**` 避免前端 jsdom 误跑 server 测试；前端 `useChat`/`ChatRoom` 测试注入 `MockSocket` 到 `global.WebSocket`，afterEach 清理。
