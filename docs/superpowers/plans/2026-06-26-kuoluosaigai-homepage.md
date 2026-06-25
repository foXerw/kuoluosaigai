# kuoluosaigai 首页实现计划（概念 A：Dollars 频道接入页）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把简陋的旧页面替换成一个有记忆点的终端风概念首页，访客像"接入匿名频道"，含开机序列、随机频道主题、聊天室入口占位。

**Architecture:** 单页 Vue 3 应用。`App.vue` 在挂载时随机抽一个"频道"（一组 design token，写入 sessionStorage），把主色注入 Ant Design `ConfigProvider` 与 CSS 变量。开机序列组件打字机式打印日志后露出主界面，主界面中心是脉动的聊天室入口，点击弹 Ant Design Modal 占位。纯静态、无后端、无网络请求。

**Tech Stack:** Vue 3（vue-cli-service 构建）、Ant Design Vue（Modal + ConfigProvider 魔改主题）、Vitest + @vue/test-utils（单元测试）、纯 CSS 动效（无动画库）。

## Global Constraints

- 底色近黑 `#0a0e0a`，不纯黑
- 4 个频道固定：`7741 SETSUBUN #39ff14`、`0313 NEBULA #22d3ee`、`0990 MAGENTA #ff2d95`、`1882 AMBER #ffb000`
- 代号格式 `PREFIX-FREQ`（如 `SETSUBUN-7741`），频率与频道固定对应，非随机数
- 抽签写入 sessionStorage key `kuoluosaigai:channel`，同会话刷新不跳变
- v1 无网络请求：移除旧 `axios` 调用 `:8000/api/nothing`
- 尊重 `prefers-reduced-motion`：关动效时直接显示终态
- v1 不做：真实聊天/WebSocket/后端/登录/移动端深度适配/多语言
- 英文文案 + 中文界面文案；等宽字体（JetBrains Mono / Fira Code）

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/theme/channels.js` | 4 频道定义、`pickChannel`/`reshuffleChannel`/`codename` 纯函数 |
| `src/composables/useTypewriter.js` | 打字机序列：逐字逐行，回调 `onLineDone`/`onAllDone` |
| `src/styles/terminal.css` | 公共终端样式：底色、扫描线、噪点、辉光、reduced-motion 兜底 |
| `src/components/BootSequence.vue` | 开机序列；prop `reducedMotion`；emit `ready` |
| `src/components/CenterGate.vue` | 脉动入口按钮；prop `color`；emit `enter` |
| `src/components/ChatPlaceholder.vue` | Ant Design Modal 占位；prop `open`；emit `close` |
| `src/components/ChannelShell.vue` | 主界面外壳：顶栏代号/频率、中心入口、状态栏 + RESHUFFLE |
| `src/App.vue` | 装配：抽频道、ConfigProvider 主题注入、phase 切换、Modal 控制 |
| `src/main.js` | 入口：挂载、引入 ant-design-vue reset.css 与 terminal.css |
| `public/index.html` | 标题改为 kuoluosaigai，favicon 指向 kuoluosaigai.ico |
| `vitest.config.js` | vitest 配置：jsdom + vue 插件 |
| `tests/*.test.js` | 各单元测试 |

---

## Task 1: 清理旧页面 + 搭建 vitest 测试框架

**Files:**
- Delete: `src/components/kuoluosaigai.vue`, `src/assets/logo.png`, `src/assets/`（若空则删目录）
- Modify: `public/index.html`（标题 + favicon）
- Create: `vitest.config.js`, `tests/smoke.test.js`
- Modify: `package.json`（scripts.test + 依赖增减）

**Interfaces:**
- Produces: `npm test` 可运行 vitest；测试环境 jsdom 提供 `sessionStorage`/`window.matchMedia`

- [ ] **Step 1: 卸载 axios，安装运行/测试依赖**

```bash
npm uninstall axios
npm install ant-design-vue
npm install -D vitest @vue/test-utils jsdom @vitejs/plugin-vue
```

- [ ] **Step 2: 删除旧页面文件**

```bash
git rm src/components/kuoluosaigai.vue src/assets/logo.png
```

- [ ] **Step 3: 写 vitest 配置**

创建 `vitest.config.js`：

```js
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
```

- [ ] **Step 4: 写冒烟测试**

创建 `tests/smoke.test.js`：

```js
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: 加 test script**

修改 `package.json` 的 `scripts`，新增 `"test": "vitest run"` 与 `"test:watch": "vitest"`：

```json
  "scripts": {
    "serve": "vue-cli-service serve",
    "build": "vue-cli-service build",
    "lint": "vue-cli-service lint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 6: 改 public/index.html**

整文件替换为：

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <link rel="icon" href="<%= BASE_URL %>kuoluosaigai.ico">
    <title>kuoluosaigai</title>
  </head>
  <body>
    <noscript>
      <strong>kuoluosaigai 需要 JavaScript 才能运行。</strong>
    </noscript>
    <div id="app"></div>
    <!-- built files will be auto injected -->
  </body>
</html>
```

- [ ] **Step 7: 临时占位 App.vue（后续 Task 9 覆写）**

整文件替换 `src/App.vue`：

```vue
<template>
  <div style="color:#39ff14;background:#0a0e0a;min-height:100vh;font-family:monospace">
    kuoluosaigai — bootstrapping…
  </div>
</template>

<script>
export default { name: 'App' }
</script>
```

同步把 `src/main.js` 改为（引入终端样式，后续 Task 9 再扩展）：

```js
import { createApp } from 'vue'
import App from './App.vue'
import './styles/terminal.css'

createApp(App).mount('#app')
```

- [ ] **Step 8: 创建空 terminal.css 占位（Task 4 填充）**

创建 `src/styles/terminal.css`：

```css
/* Task 4 填充 */
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `npm test`
Expected: 1 个 smoke 测试通过

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "chore: 清理旧页面，搭建 vitest 测试框架"
```

---

## Task 2: 频道定义与抽签逻辑（theme/channels.js）

**Files:**
- Create: `src/theme/channels.js`
- Test: `tests/channels.test.js`

**Interfaces:**
- Produces:
  - `CHANNELS: Array<{ freq: string, prefix: string, color: string, glow: string }>`
  - `pickChannel(rng?: () => number): Channel` —— 读 sessionStorage，无则按 rng 抽一个并写入
  - `reshuffleChannel(rng?: () => number): Channel` —— 忽略旧值，按 rng 抽并写入
  - `codename(channel: Channel): string` —— `PREFIX-FREQ`

- [ ] **Step 1: 写失败测试**

创建 `tests/channels.test.js`：

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { CHANNELS, pickChannel, reshuffleChannel, codename } from '../src/theme/channels'

describe('channels', () => {
  beforeEach(() => sessionStorage.clear())

  it('exposes 4 channels with required fields', () => {
    expect(CHANNELS).toHaveLength(4)
    for (const c of CHANNELS) {
      expect(c).toHaveProperty('freq')
      expect(c).toHaveProperty('prefix')
      expect(c).toHaveProperty('color')
      expect(c).toHaveProperty('glow')
    }
  })

  it('pickChannel returns a channel from CHANNELS', () => {
    const c = pickChannel(() => 0.5)
    expect(CHANNELS).toContainEqual(c)
  })

  it('pickChannel persists to sessionStorage and returns same channel on second call', () => {
    const first = pickChannel(() => 0.5)
    const second = pickChannel(() => 0.99) // rng 被忽略，因 storage 命中
    expect(second).toEqual(first)
  })

  it('reshuffleChannel returns a channel and updates storage', () => {
    const c = reshuffleChannel(() => 0.1)
    expect(CHANNELS).toContainEqual(c)
    expect(sessionStorage.getItem('kuoluosaigai:channel')).toBe(c.freq)
  })

  it('codename formats as PREFIX-FREQ', () => {
    expect(codename(CHANNELS[0])).toBe(`${CHANNELS[0].prefix}-${CHANNELS[0].freq}`)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/channels.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 channels.js**

创建 `src/theme/channels.js`：

```js
export const CHANNELS = [
  { freq: '7741', prefix: 'SETSUBUN', color: '#39ff14', glow: '#39ff14' },
  { freq: '0313', prefix: 'NEBULA',   color: '#22d3ee', glow: '#22d3ee' },
  { freq: '0990', prefix: 'MAGENTA',  color: '#ff2d95', glow: '#ff2d95' },
  { freq: '1882', prefix: 'AMBER',    color: '#ffb000', glow: '#ffb000' },
]

const STORAGE_KEY = 'kuoluosaigai:channel'

export function codename(channel) {
  return `${channel.prefix}-${channel.freq}`
}

export function pickChannel(rng = Math.random) {
  const stored = sessionStorage.getItem(STORAGE_KEY)
  if (stored) {
    const found = CHANNELS.find((c) => c.freq === stored)
    if (found) return found
  }
  const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)]
  sessionStorage.setItem(STORAGE_KEY, channel.freq)
  return channel
}

export function reshuffleChannel(rng = Math.random) {
  const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)]
  sessionStorage.setItem(STORAGE_KEY, channel.freq)
  return channel
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/channels.test.js`
Expected: PASS（5 个）

- [ ] **Step 5: 提交**

```bash
git add src/theme/channels.js tests/channels.test.js
git commit -m "feat(theme): 频道定义与抽签逻辑"
```

---

## Task 3: 打字机 composable（composables/useTypewriter.js）

**Files:**
- Create: `src/composables/useTypewriter.js`
- Test: `tests/useTypewriter.test.js`

**Interfaces:**
- Produces: `useTypewriter(): { lines: Ref<string[]>, currentText: Ref<string>, done: Ref<boolean>, typeSequence(sequence: string[], opts?: { charDelay?: number, lineDelay?: number, onLineDone?: (line: string) => void, onAllDone?: () => void }): Promise<void> }`

- [ ] **Step 1: 写失败测试**

创建 `tests/useTypewriter.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTypewriter } from '../src/composables/useTypewriter'

describe('useTypewriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('types lines in order and signals done', async () => {
    const { lines, done, typeSequence } = useTypewriter()
    const p = typeSequence(['ab', 'cd'], { charDelay: 10, lineDelay: 10 })
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(lines.value).toEqual(['ab', 'cd'])
    expect(done.value).toBe(true)
  })

  it('invokes onAllDone after sequence', async () => {
    const { typeSequence } = useTypewriter()
    let finished = false
    const p = typeSequence(['x'], {
      charDelay: 5,
      lineDelay: 5,
      onAllDone: () => { finished = true },
    })
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(finished).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/useTypewriter.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 useTypewriter.js**

创建 `src/composables/useTypewriter.js`：

```js
import { ref } from 'vue'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useTypewriter() {
  const lines = ref([])
  const currentText = ref('')
  const done = ref(false)

  async function typeSequence(sequence, opts = {}) {
    const { charDelay = 24, lineDelay = 220, onLineDone, onAllDone } = opts
    done.value = false
    lines.value = []
    for (const line of sequence) {
      currentText.value = ''
      for (const ch of line) {
        currentText.value += ch
        await delay(charDelay)
      }
      lines.value.push(line)
      currentText.value = ''
      onLineDone?.(line)
      await delay(lineDelay)
    }
    done.value = true
    onAllDone?.()
  }

  return { lines, currentText, done, typeSequence }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/useTypewriter.test.js`
Expected: PASS（2 个）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useTypewriter.js tests/useTypewriter.test.js
git commit -m "feat(composable): 打字机序列"
```

---

## Task 4: 终端公共样式（styles/terminal.css）

**Files:**
- Modify: `src/styles/terminal.css`（填充 Task 1 的占位）

**Interfaces:**
- Produces: CSS 变量 `--app-bg` `--app-color` `--app-glow` `--app-mono`；`.shell__bg::before/::after` 扫描线/噪点；`.glow` 辉光；reduced-motion 全局降级

- [ ] **Step 1: 填充 terminal.css**

整文件替换 `src/styles/terminal.css`：

```css
:root {
  --app-bg: #0a0e0a;
  --app-color: #39ff14;
  --app-glow: #39ff14;
  --app-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html, body, #app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--app-bg);
  color: var(--app-color);
  font-family: var(--app-mono);
}

/* 扫描线 */
.shell__bg::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0) 0,
    rgba(0, 0, 0, 0) 2px,
    rgba(0, 0, 0, 0.25) 3px,
    rgba(0, 0, 0, 0) 4px
  );
  z-index: 1;
}

/* 噪点 */
.shell__bg::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.04;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  z-index: 2;
}

.glow {
  text-shadow: 0 0 6px var(--app-glow), 0 0 12px var(--app-glow);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@keyframes blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/styles/terminal.css
git commit -m "style: 终端公共样式（扫描线/噪点/辉光/降级）"
```

---

## Task 5: 开机序列组件（BootSequence.vue）

**Files:**
- Create: `src/components/BootSequence.vue`
- Test: `tests/BootSequence.test.js`

**Interfaces:**
- Consumes: `useTypewriter`（Task 3）
- Produces: 组件 `BootSequence`，prop `reducedMotion: Boolean`（默认 false），emit `ready`；渲染 `.boot__line`（4 条）与 `.boot__enter` 按钮（done 后出现）

- [ ] **Step 1: 写失败测试**

创建 `tests/BootSequence.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BootSequence from '../src/components/BootSequence.vue'

describe('BootSequence', () => {
  it('renders all lines under reduced motion and emits ready on click', async () => {
    const wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    expect(wrapper.findAll('.boot__line')).toHaveLength(4)
    const btn = wrapper.find('.boot__enter')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/BootSequence.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 BootSequence.vue**

创建 `src/components/BootSequence.vue`：

```vue
<template>
  <div class="boot">
    <div class="boot__log">
      <p v-for="(l, i) in lines" :key="i" class="boot__line"><span class="boot__prompt">&gt;</span> {{ l }}</p>
      <p v-if="!done" class="boot__current glow">{{ currentText }}<span class="boot__cursor">▋</span></p>
    </div>
    <button v-if="done" class="boot__enter glow" @click="$emit('ready')">[ press ENTER to join ]</button>
  </div>
</template>

<script>
import { useTypewriter } from '../composables/useTypewriter'

const SEQUENCE = [
  '[BOOT] kuoluosaigai channel daemon v0.1',
  '[OK] handshake',
  '[FREQ] tuning...',
  '[READY] press ENTER to join.',
]

export default {
  name: 'BootSequence',
  props: {
    reducedMotion: { type: Boolean, default: false },
  },
  emits: ['ready'],
  setup() {
    const { lines, currentText, done, typeSequence } = useTypewriter()
    return { lines, currentText, done, typeSequence, SEQUENCE }
  },
  async mounted() {
    if (this.reducedMotion) {
      this.lines.push(...SEQUENCE)
      this.done = true
      return
    }
    await this.typeSequence(SEQUENCE, { charDelay: 24, lineDelay: 220 })
  },
}
</script>

<style scoped>
.boot {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  padding: 0 8vw;
}
.boot__log { font-size: 14px; line-height: 1.8; }
.boot__prompt { margin-right: 8px; opacity: 0.7; }
.boot__cursor { animation: blink 1s steps(1) infinite; margin-left: 2px; }
.boot__enter {
  margin-top: 24px;
  background: none;
  border: 1px solid var(--app-color);
  color: var(--app-color);
  font-family: var(--app-mono);
  padding: 10px 18px;
  cursor: pointer;
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/BootSequence.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/BootSequence.vue tests/BootSequence.test.js
git commit -m "feat(boot): 开机序列组件"
```

---

## Task 6: 聊天室入口（CenterGate.vue）

**Files:**
- Create: `src/components/CenterGate.vue`
- Test: `tests/CenterGate.test.js`

**Interfaces:**
- Produces: 组件 `CenterGate`，prop `color: String`，emit `enter`；含 `.gate__label`（文案"进入聊天室"）

- [ ] **Step 1: 写失败测试**

创建 `tests/CenterGate.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CenterGate from '../src/components/CenterGate.vue'

describe('CenterGate', () => {
  it('renders label and emits enter on click', async () => {
    const wrapper = mount(CenterGate, { props: { color: '#39ff14' } })
    expect(wrapper.text()).toContain('进入聊天室')
    await wrapper.trigger('click')
    expect(wrapper.emitted('enter')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/CenterGate.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 CenterGate.vue**

创建 `src/components/CenterGate.vue`：

```vue
<template>
  <button class="gate" :style="{ '--gate-color': color }" @click="$emit('enter')">
    <span class="gate__pulse" />
    <span class="gate__label glow">进入聊天室</span>
    <span class="gate__sub">ENTER CHANNEL</span>
  </button>
</template>

<script>
export default {
  name: 'CenterGate',
  props: {
    color: { type: String, default: '#39ff14' },
  },
  emits: ['enter'],
}
</script>

<style scoped>
.gate {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: none;
  border: 1px solid var(--gate-color);
  color: var(--gate-color);
  font-family: var(--app-mono);
  padding: 28px 48px;
  cursor: pointer;
}
.gate__label { font-size: 20px; letter-spacing: 2px; }
.gate__sub { font-size: 11px; opacity: 0.6; letter-spacing: 3px; }
.gate__pulse {
  position: absolute;
  inset: -1px;
  border: 1px solid var(--gate-color);
  animation: pulse 1.8s ease-in-out infinite;
  pointer-events: none;
}
.gate:hover { background: rgba(255, 255, 255, 0.04); }
</style>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/CenterGate.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/CenterGate.vue tests/CenterGate.test.js
git commit -m "feat(gate): 聊天室入口组件"
```

---

## Task 7: 聊天室占位弹层（ChatPlaceholder.vue）

**Files:**
- Create: `src/components/ChatPlaceholder.vue`
- Test: `tests/ChatPlaceholder.test.js`

**Interfaces:**
- Consumes: `ant-design-vue` 的 `Modal`（Task 1 已安装）
- Produces: 组件 `ChatPlaceholder`，prop `open: Boolean`，emit `close`；渲染文案"频道尚未开放"

- [ ] **Step 1: 写失败测试**

创建 `tests/ChatPlaceholder.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatPlaceholder from '../src/components/ChatPlaceholder.vue'

describe('ChatPlaceholder', () => {
  it('renders placeholder copy when open', () => {
    const wrapper = mount(ChatPlaceholder, {
      props: { open: true },
      global: {
        stubs: { 'a-modal': { template: '<div><slot /></div>' } },
      },
    })
    expect(wrapper.text()).toContain('频道尚未开放')
    expect(wrapper.text()).toContain('coming soon')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/ChatPlaceholder.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 ChatPlaceholder.vue**

创建 `src/components/ChatPlaceholder.vue`：

```vue
<template>
  <a-modal
    :open="open"
    :centered="true"
    :footer="null"
    :closable="true"
    class="chat-placeholder"
    @cancel="$emit('close')"
  >
    <div class="chat-placeholder__body">
      <p class="chat-placeholder__title glow">频道尚未开放</p>
      <p class="chat-placeholder__sub">channel offline — coming soon</p>
    </div>
  </a-modal>
</template>

<script>
import { Modal } from 'ant-design-vue'

export default {
  name: 'ChatPlaceholder',
  components: { 'a-modal': Modal },
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['close'],
}
</script>

<style scoped>
.chat-placeholder__body {
  text-align: center;
  padding: 24px 8px;
  font-family: var(--app-mono);
  color: var(--app-color);
}
.chat-placeholder__title { font-size: 18px; letter-spacing: 2px; margin: 0 0 8px; }
.chat-placeholder__sub { font-size: 12px; opacity: 0.6; margin: 0; }
</style>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/ChatPlaceholder.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/ChatPlaceholder.vue tests/ChatPlaceholder.test.js
git commit -m "feat(chat): 聊天室占位弹层（Ant Design Modal）"
```

---

## Task 8: 主界面外壳（ChannelShell.vue）

**Files:**
- Create: `src/components/ChannelShell.vue`
- Test: `tests/ChannelShell.test.js`

**Interfaces:**
- Consumes: `CenterGate`（Task 6）
- Produces: 组件 `ChannelShell`，prop `channel: { freq, prefix, color, glow }`，emit `enter`/`reshuffle`；渲染代号 `PREFIX-FREQ`（`.shell__codename`）、`FREQ <freq>`、`.shell__reshuffle` 按钮

- [ ] **Step 1: 写失败测试**

创建 `tests/ChannelShell.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChannelShell from '../src/components/ChannelShell.vue'

const CHANNEL = { freq: '7741', prefix: 'SETSUBUN', color: '#39ff14', glow: '#39ff14' }

describe('ChannelShell', () => {
  it('renders codename and freq', () => {
    const wrapper = mount(ChannelShell, {
      props: { channel: CHANNEL },
      global: { stubs: { CenterGate: true } },
    })
    expect(wrapper.text()).toContain('SETSUBUN-7741')
    expect(wrapper.text()).toContain('FREQ 7741')
  })

  it('emits reshuffle on button click', async () => {
    const wrapper = mount(ChannelShell, {
      props: { channel: CHANNEL },
      global: { stubs: { CenterGate: true } },
    })
    await wrapper.find('.shell__reshuffle').trigger('click')
    expect(wrapper.emitted('reshuffle')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/ChannelShell.test.js`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 ChannelShell.vue**

创建 `src/components/ChannelShell.vue`：

```vue
<template>
  <div class="shell" :style="{ '--app-color': channel.color, '--app-glow': channel.glow }">
    <div class="shell__bg" aria-hidden="true" />
    <header class="shell__top">
      <span class="shell__codename glow">{{ codename }}</span>
      <span class="shell__freq">FREQ {{ channel.freq }}</span>
    </header>
    <main class="shell__center">
      <CenterGate :color="channel.color" @enter="$emit('enter')" />
    </main>
    <footer class="shell__status">
      <span class="shell__online">● {{ online }} online</span>
      <span class="shell__clock">{{ clock }}</span>
      <button class="shell__reshuffle" @click="$emit('reshuffle')">🔀 RESHUFFLE</button>
    </footer>
  </div>
</template>

<script>
import CenterGate from './CenterGate.vue'

export default {
  name: 'ChannelShell',
  components: { CenterGate },
  props: {
    channel: { type: Object, required: true },
  },
  emits: ['enter', 'reshuffle'],
  data() {
    return {
      online: 1 + Math.floor(Math.random() * 99),
      clock: '',
      timer: null,
    }
  },
  computed: {
    codename() {
      return `${this.channel.prefix}-${this.channel.freq}`
    },
  },
  mounted() {
    this.tick()
    this.timer = setInterval(this.tick, 1000)
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer)
  },
  methods: {
    tick() {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      this.clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    },
  },
}
</script>

<style scoped>
.shell {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: var(--app-color);
}
.shell__top, .shell__status {
  display: flex;
  justify-content: space-between;
  padding: 16px 24px;
  font-size: 12px;
  letter-spacing: 2px;
  position: relative;
  z-index: 3;
}
.shell__center {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  z-index: 3;
}
.shell__reshuffle {
  background: none;
  border: 1px solid var(--app-color);
  color: var(--app-color);
  font-family: var(--app-mono);
  padding: 4px 10px;
  cursor: pointer;
}
</style>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/ChannelShell.test.js`
Expected: PASS（2 个）

- [ ] **Step 5: 提交**

```bash
git add src/components/ChannelShell.vue tests/ChannelShell.test.js
git commit -m "feat(shell): 主界面外壳（代号/状态栏/RESHUFFLE）"
```

---

## Task 9: 装配 App.vue + main.js

**Files:**
- Modify: `src/App.vue`（覆写 Task 1 占位）
- Modify: `src/main.js`（引入 ant-design-vue reset.css）
- Test: `tests/App.test.js`

**Interfaces:**
- Consumes: `pickChannel`/`reshuffleChannel`（Task 2）、`BootSequence`/`ChannelShell`/`ChatPlaceholder`、`ant-design-vue` 的 `ConfigProvider`
- Produces: `App`，`data.channel` 为当前频道对象，`data.phase` 为 `'boot'|'shell'`

- [ ] **Step 1: 写失败测试**

创建 `tests/App.test.js`：

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'

describe('App', () => {
  beforeEach(() => sessionStorage.clear())

  const stubs = {
    'a-config-provider': { template: '<div><slot /></div>' },
    BootSequence: { template: '<div class="boot-stub" @click="$emit(\'ready\')" />', emits: ['ready'] },
    ChannelShell: true,
    ChatPlaceholder: true,
  }

  it('starts in boot phase then enters shell on ready', async () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    await wrapper.find('.boot-stub').trigger('click')
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('picks a channel on creation', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.vm.channel).toBeTruthy()
    expect(wrapper.vm.channel.freq).toMatch(/^\d{4}$/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/App.test.js`
Expected: FAIL（App.vue 仍是占位，无 channel/phase）

- [ ] **Step 3: 实现 App.vue**

整文件替换 `src/App.vue`：

```vue
<template>
  <a-config-provider :theme="themeConfig">
    <div class="app" :style="{ '--app-color': currentColor, '--app-glow': currentGlow }">
      <BootSequence v-if="phase === 'boot'" :reduced-motion="reducedMotion" @ready="enter" />
      <ChannelShell v-else :channel="channel" @enter="openPlaceholder" @reshuffle="reshuffle" />
      <ChatPlaceholder :open="placeholderOpen" @close="placeholderOpen = false" />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatPlaceholder from './components/ChatPlaceholder.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'

export default {
  name: 'App',
  components: {
    'a-config-provider': ConfigProvider,
    BootSequence,
    ChannelShell,
    ChatPlaceholder,
  },
  data() {
    return {
      phase: 'boot',
      channel: null,
      placeholderOpen: false,
      reducedMotion: false,
    }
  },
  computed: {
    currentColor() {
      return this.channel?.color || '#39ff14'
    },
    currentGlow() {
      return this.channel?.glow || '#39ff14'
    },
    themeConfig() {
      return { token: { colorPrimary: this.currentColor } }
    },
  },
  created() {
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.channel = pickChannel()
  },
  methods: {
    enter() {
      this.phase = 'shell'
    },
    openPlaceholder() {
      this.placeholderOpen = true
    },
    reshuffle() {
      this.channel = reshuffleChannel()
    },
  },
}
</script>

<style scoped>
.app { min-height: 100vh; }
</style>
```

- [ ] **Step 4: 实现 main.js**

整文件替换 `src/main.js`：

```js
import { createApp } from 'vue'
import App from './App.vue'
import 'ant-design-vue/dist/reset.css'
import './styles/terminal.css'

createApp(App).mount('#app')
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/App.test.js`
Expected: PASS（2 个）

- [ ] **Step 6: 提交**

```bash
git add src/App.vue src/main.js tests/App.test.js
git commit -m "feat(app): 装配首页（频道抽签/主题注入/相位切换）"
```

---

## Task 10: 全量测试 + 构建 + 手测清单

**Files:**
- 无新建；仅运行验证

- [ ] **Step 1: 跑全量单元测试**

Run: `npm test`
Expected: 全部通过（smoke 1 + channels 5 + useTypewriter 2 + BootSequence 1 + CenterGate 1 + ChatPlaceholder 1 + ChannelShell 2 + App 2 = 15）

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: 成功产出 `dist/`，无报错

- [ ] **Step 3: 本地预览手测**

Run: `npm run serve`，浏览器打开本地地址，逐项确认：
- [ ] 开机序列逐行打印、光标闪烁、出现 `[ press ENTER to join ]`
- [ ] 点击/回车后进入主界面，背景扫描线 + 噪点
- [ ] 顶栏显示 `SETSUBUN-7741`（或其它频道，4 选 1）+ `FREQ xxxx`
- [ ] 状态栏显示在线人数（假值）、走秒时钟、`🔀 RESHUFFLE`
- [ ] 点 RESHUFFLE：主色 + 代号 + 频率整体切换
- [ ] 点「进入聊天室」：弹出 Modal "频道尚未开放 / coming soon"，关闭正常
- [ ] 刷新页面：同会话频道不变（sessionStorage）
- [ ] 系统设置开启"减少动效"后刷新：跳过开机动画，直接显示主界面

- [ ] **Step 4: 提交验证记录（可选，更新 README）**

如手测全过，可更新 `README.md` 加一段"本地开发/构建/测试"说明（非必需）。若更新则：

```bash
git add README.md
git commit -m "docs: 更新本地开发说明"
```

---

## Self-Review 结果

- **Spec 覆盖**：开机序列（T5）、主界面（T8）、随机频道（T2/T9）、进入入口占位（T7/T9）、RESHUFFLE（T8/T9）、Ant Design 魔改主题（T9 ConfigProvider）、reduced-motion（T5/T9）、移除 axios（T1）、终端公共样式（T4）——均有任务覆盖。
- **占位扫描**：无 TBD/TODO；每步含完整代码或确切命令。
- **类型/命名一致**：`pickChannel`/`reshuffleChannel`/`codename`/`CHANNELS`、`useTypewriter` 返回 `{ lines, currentText, done, typeSequence }`、组件 props/emits 在跨任务中名称一致。
