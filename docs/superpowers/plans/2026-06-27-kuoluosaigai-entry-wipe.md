# 接入动画补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 v1 记录的 spec 偏差——Enter 键 / 点击屏幕任意处触发接入，一道自上而下的扫描线 wipe 扫过，露出主界面。

**Architecture:** App.vue 相位由两态 `boot|shell` 扩为三态 `boot|wiping|shell`。新增 `ScanlineWipe.vue` 覆盖层组件（挂载即播放扫描条动画，`animationend` 后 emit `done`）。`BootSequence.vue` 加 window Enter 键 + 根元素 click 监听（仅打字机 `done` 后生效），末行按钮降级为纯文案。淡入淡出用 CSS keyframe 动画（挂载即播放，避免 transition 挂载时序竞态），与扫描条共用 `--wipe-ms` 时长。`prefers-reduced-motion` 时 App 直达 shell、不挂 ScanlineWipe。

**Tech Stack:** Vue 3 (Options API)、vitest + @vue/test-utils + jsdom、纯 CSS 动画。

## Global Constraints

- 扫描条与淡入淡出共用时长 `--wipe-ms: 600ms`（定义于 `src/styles/terminal.css :root`）。
- 扫描条颜色取 `var(--app-color)`（当前频道主色，随频道/RESHUFFLE 变化）。
- `prefers-reduced-motion: reduce` 时跳过 wipe，`ready` 直达 `phase='shell'`，不挂载 ScanlineWipe、无淡入淡出（与 v1 策略一致；`terminal.css` 已有全局 `animation:none!important` 兜底）。
- 仅当打字机 `done === true` 时触发才生效；Enter 键忽略带 Ctrl/Cmd/Shift/Alt 修饰符的组合。
- 不新增依赖。测试用 vitest（`npm test`）。

---

### Task 1: ScanlineWipe 覆盖层组件

**Files:**
- Create: `src/components/ScanlineWipe.vue`
- Test: `tests/ScanlineWipe.test.js`

**Interfaces:**
- Consumes: `var(--app-color)`、`var(--wipe-ms)`（CSS 变量，由 `terminal.css` / `App.vue` 提供）
- Produces: 组件 `ScanlineWipe`，props 无，emits `done`（在 `.wipe__line` 的 `animationend` 触发）。挂载即播放一次 `wipeSweep` 动画。

- [ ] **Step 1: Write the failing test**

Create `tests/ScanlineWipe.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScanlineWipe from '../src/components/ScanlineWipe.vue'

describe('ScanlineWipe', () => {
  it('renders the scanline bar', () => {
    const wrapper = mount(ScanlineWipe)
    expect(wrapper.find('.wipe__line').exists()).toBe(true)
  })

  it('emits done when the bar animation ends', async () => {
    const wrapper = mount(ScanlineWipe)
    await wrapper.find('.wipe__line').trigger('animationend')
    expect(wrapper.emitted('done')).toBeTruthy()
    expect(wrapper.emitted('done')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ScanlineWipe.test.js`
Expected: FAIL — `Cannot find module '../src/components/ScanlineWipe.vue'` (组件尚未创建)。

- [ ] **Step 3: Write minimal implementation**

Create `src/components/ScanlineWipe.vue`:

```html
<template>
  <div class="wipe" aria-hidden="true">
    <div class="wipe__line" @animationend="$emit('done')"></div>
  </div>
</template>

<script>
export default {
  name: 'ScanlineWipe',
  emits: ['done'],
}
</script>

<style scoped>
.wipe {
  position: absolute;
  inset: 0;
  z-index: 50;
  pointer-events: none;
}
.wipe__line {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: var(--app-color);
  box-shadow: 0 0 16px 4px var(--app-color);
  animation: wipeSweep var(--wipe-ms) ease-in;
}
@keyframes wipeSweep {
  from { top: 0; }
  to { top: 100%; }
}
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ScanlineWipe.test.js`
Expected: PASS — 2 tests pass.（jsdom 不执行 CSS 动画，但 `trigger('animationend')` 派发 Event('animationend')，Vue 的 `@animationend` 监听器仍触发 `$emit('done')`。）

- [ ] **Step 5: Commit**

```bash
git add src/components/ScanlineWipe.vue tests/ScanlineWipe.test.js
git commit -m "feat(wipe): 扫描线覆盖层组件（自终止 animationend→done）"
```

---

### Task 2: BootSequence 触发器（Enter + 点击任意处）

**Files:**
- Modify: `src/components/BootSequence.vue`（模板 + script + style）
- Test: `tests/BootSequence.test.js`（重写）

**Interfaces:**
- Consumes: 无新接口；沿用 `useTypewriter` 的 `done`
- Produces: `BootSequence` 仍 emits `ready`，触发源新增 window `keydown`（Enter）+ 根元素 `.boot` `click`；末行 `.boot__enter` 按钮移除，改为纯文案 `.boot__hint`。仅 `done` 时触发。

- [ ] **Step 1: Write the failing tests**

Replace entire contents of `tests/BootSequence.test.js` with:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BootSequence from '../src/components/BootSequence.vue'

function keydown(key, mods = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...mods }))
}

describe('BootSequence', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount?.()
    vi.useRealTimers()
  })

  it('renders all lines under reduced motion and emits ready on click', async () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    expect(wrapper.findAll('.boot__line')).toHaveLength(4)
    await wrapper.find('.boot').trigger('click')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })

  it('emits ready on Enter key when done', () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    keydown('Enter')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })

  it('ignores Enter combined with modifier keys', () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    keydown('Enter', { ctrlKey: true })
    keydown('Enter', { shiftKey: true })
    keydown('Enter', { metaKey: true })
    keydown('Enter', { altKey: true })
    expect(wrapper.emitted('ready')).toBeFalsy()
  })

  it('does not emit ready before the typewriter finishes', () => {
    vi.useFakeTimers()
    wrapper = mount(BootSequence, { props: { reducedMotion: false } })
    keydown('Enter')
    expect(wrapper.emitted('ready')).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/BootSequence.test.js`
Expected: FAIL — 前两个用例找不到 `.boot` click 触发 ready（现有按钮 `.boot__enter` 已不匹配新测试的 `.boot` 根点击 / Enter 键路径未实现）；Enter 键用例 fail。

- [ ] **Step 3: Write minimal implementation**

Replace entire contents of `src/components/BootSequence.vue` with:

```html
<template>
  <div class="boot" @click="onClick">
    <div class="boot__log">
      <p v-for="(l, i) in lines" :key="i" class="boot__line"><span class="boot__prompt">&gt;</span> {{ l }}</p>
      <p v-if="!done" class="boot__current glow">{{ currentText }}<span class="boot__cursor">▋</span></p>
    </div>
    <p v-if="done" class="boot__hint glow">[ press ENTER to join ]</p>
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
  setup(props) {
    const { lines, currentText, done, typeSequence } = useTypewriter()
    if (props.reducedMotion) {
      lines.value.push(...SEQUENCE)
      done.value = true
    }
    return { lines, currentText, done, typeSequence, SEQUENCE }
  },
  async mounted() {
    window.addEventListener('keydown', this.onKey)
    if (this.reducedMotion) return
    await this.typeSequence(SEQUENCE, { charDelay: 24, lineDelay: 220 })
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey)
  },
  methods: {
    onKey(e) {
      if (e.key !== 'Enter') return
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      this.maybeReady()
    },
    onClick() {
      this.maybeReady()
    },
    maybeReady() {
      if (!this.done) return
      this.$emit('ready')
    },
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
.boot__hint {
  margin-top: 24px;
  color: var(--app-color);
  font-family: var(--app-mono);
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/BootSequence.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/BootSequence.vue tests/BootSequence.test.js
git commit -m "feat(boot): Enter/点击任意处触发接入，末行降级为纯文案"
```

---

### Task 3: App 三态编排 + 淡入淡出 CSS

**Files:**
- Modify: `src/App.vue`（模板 + script + style）
- Modify: `src/styles/terminal.css`（`:root` 加 `--wipe-ms`）
- Test: `tests/App.test.js`（重写第一个 `describe('App')` 块；保留 `describe('App channel theming')`）

**Interfaces:**
- Consumes: `BootSequence`（emit `ready`）、`ScanlineWipe`（emit `done`）、`ChannelShell`
- Produces: App 相位 `phase: 'boot' | 'wiping' | 'shell'`；`ready` → 非 reduced 时 `phase='wiping'`（挂 ChannelShell + ScanlineWipe，boot 留挂载淡出），reduced 时 `phase='shell'`；`done` → `phase='shell'`。

- [ ] **Step 1: Write the failing tests**

Replace the entire first `describe('App', () => { ... })` block in `tests/App.test.js` (lines 6–28) with the block below. Keep the `import` lines (add `vi` to the vitest import) and keep `describe('App channel theming', ...)` unchanged.

The new top of `tests/App.test.js` (imports + first describe block):

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
    ChatPlaceholder: true,
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

  it('picks a channel on creation', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.vm.channel).toBeTruthy()
    expect(wrapper.vm.channel.freq).toMatch(/^\d{4}$/)
  })
})
```

Leave `describe('App channel theming', ...)` (the second block) exactly as-is.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/App.test.js`
Expected: FAIL — `enters wiping on ready` 找不到 `.wipe-stub`（App 尚未挂载 ScanlineWipe）；`enters shell on wipe done` 无 wipe 路径；reduced-motion 用例未跳过 wipe。

- [ ] **Step 3: Add the shared wipe duration token**

In `src/styles/terminal.css`, add `--wipe-ms` to the `:root` block so it reads:

```css
:root {
  --app-bg: #0a0e0a;
  --app-color: #39ff14;
  --app-glow: #39ff14;
  --app-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --wipe-ms: 600ms;
}
```

- [ ] **Step 4: Implement App three-phase orchestration**

Replace entire contents of `src/App.vue` with:

```html
<template>
  <a-config-provider :theme="themeConfig">
    <div class="app" :class="phaseClass">
      <BootSequence
        v-if="phase === 'boot' || phase === 'wiping'"
        class="app__boot"
        :reduced-motion="reducedMotion"
        @ready="onReady"
      />
      <ChannelShell
        v-if="phase === 'wiping' || phase === 'shell'"
        class="app__shell"
        :channel="channel"
        @enter="openPlaceholder"
        @reshuffle="reshuffle"
      />
      <ScanlineWipe v-if="phase === 'wiping'" @done="onWipeDone" />
      <ChatPlaceholder :open="placeholderOpen" @close="placeholderOpen = false" />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatPlaceholder from './components/ChatPlaceholder.vue'
import ScanlineWipe from './components/ScanlineWipe.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'

export default {
  name: 'App',
  components: {
    'a-config-provider': ConfigProvider,
    BootSequence,
    ChannelShell,
    ChatPlaceholder,
    ScanlineWipe,
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
    phaseClass() {
      return 'app--' + this.phase
    },
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
  watch: {
    currentColor: {
      immediate: true,
      handler(value) {
        if (typeof document !== 'undefined') {
          document.documentElement.style.setProperty('--app-color', value)
        }
      },
    },
    currentGlow: {
      immediate: true,
      handler(value) {
        if (typeof document !== 'undefined') {
          document.documentElement.style.setProperty('--app-glow', value)
        }
      },
    },
  },
  created() {
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.channel = pickChannel()
  },
  methods: {
    onReady() {
      this.phase = this.reducedMotion ? 'shell' : 'wiping'
    },
    onWipeDone() {
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
.app {
  position: relative;
  min-height: 100vh;
}
.app__boot { opacity: 1; }
.app__shell { opacity: 1; }
.app--wiping .app__boot {
  position: absolute;
  inset: 0;
  animation: bootOut var(--wipe-ms) ease-in forwards;
}
.app--wiping .app__shell {
  animation: shellIn var(--wipe-ms) ease-in;
}
@keyframes bootOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes shellIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/App.test.js`
Expected: PASS — 5 tests in `App` block + 1 in theming block pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 全部测试通过（smoke、channels、useTypewriter、BootSequence、ChannelShell、CenterGate、ChatPlaceholder、ScanlineWipe、App）。

- [ ] **Step 7: Commit**

```bash
git add src/App.vue src/styles/terminal.css tests/App.test.js
git commit -m "feat(app): 三态相位（boot→wiping→shell）+ 扫描线接入动画"
```

---

## Self-Review Notes

- **Spec coverage:** spec §1 触发（Enter + 点击任意处）→ Task 2；spec §2 ScanlineWipe 组件 → Task 1；spec §3 三态数据流 + 淡入淡出 → Task 3；spec §4 动效规格（3px、主色、600ms、reduced-motion 降级）→ Task 1+3；spec §5 测试 → 三个 task 的测试步骤覆盖 ScanlineWipe/BootSequence/App 全部用例；spec §6 范围边界未越界（无 RESHUFFLE wipe、无真聊天、无 clip-path 帘幕）。
- **Placeholder scan:** 无 TBD/TODO；每步含完整代码与确切命令。
- **Type/命名一致:** `ScanlineWipe` emits `done`（Task 1 定义，Task 3 `@done="onWipeDone"` 消费一致）；`BootSequence` emits `ready`（Task 2 定义，Task 3 `@ready="onReady"` 一致）；`phase` 三态字符串在 Task 3 模板与方法中一致；`--wipe-ms` 在 Task 3 Step 3 定义、ScanlineWipe（Task 1）与 App fade（Task 3）消费一致。
- **CSS 动画而非 transition:** keyframe 动画在元素挂载/加类时即播放，规避 transition 挂载时序竞态；jsdom 不执行动画不影响测试（测试只断言相位与挂载/卸载、`animationend` 事件驱动）。
