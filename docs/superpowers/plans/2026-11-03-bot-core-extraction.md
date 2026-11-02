# P0 `bot-core` 抽包 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/bots/` 的 bot 逻辑抽成宿主无关的 `packages/bot-core` 包，使同一份代码既能被浏览器面板使用（行为逐字节不变），也能被后续的 `saigai-bot` daemon（P1）在纯 Node 环境下 import。

**Architecture:** 一次**搬运 + 一刀切分**，不重写任何逻辑。6 个纯模块 + `historyMerge` 平移进 `packages/bot-core`；`store.js` 的 652 行拆成「core `deck.js`（含全部编排逻辑）」+「浏览器薄适配 `src/bots/store.js`」。core 通过**三个注入端口**摆脱浏览器依赖：`reactiveImpl`（Vue 的 `reactive`）、`lease`（跨标签互斥，daemon 用恒真的 null lease）、`getOwnerNick`（读 sessionStorage）。`createBotStore` 的**对外签名保持不变**，因此 12 个既有测试文件与 3 个组件的 import 路径与用法零改动。

**Tech Stack:** Node ESM + npm workspaces、Vue 3 `reactive`、`ws`（仅 P1 daemon 用，本阶段零新增依赖）、Vitest（jsdom，新增文件按需用 `// @vitest-environment node`）。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §6 §7（本计划只实现 P0；P4/P1/P2/P3 各自单开计划）

---

## Global Constraints

- 零新增运行时依赖（`bot-core` 与 `src/` 均不得引入新 npm 包；`ws` 只在 P1 的 daemon 包出现）
- 测试基线 **362（323 客户端 + 39 服务端）**，**只增不减**；既有单测的**断言与用例一律不得改动**（import 路径行随搬包调整除外，见 R1）；**禁止为了通过而改断言**
- **R1（预扫描裁定）**：`tests/botStore.test.js` 锚定的是"**断言零改动**"，不是"字节零改动"——它 `:9` import 了会被搬走的 `../src/bots/rhythm`，路径行必须随搬包改。留转发 shim 让路径不动是**更坏**的选择（第二个入口 = spec A8 core 分叉）。补偿证据：`git diff` 里该文件的改动**只允许出现在 import 块内**
- **R1 例外（Task 1 审查追加）**：因搬运而**必然变红**的"反空跑目录计数"canary 允许同步改数值
  （实例：`tests/botIsolation.test.js:102` 的 `≥8`→`≥2`，等于搬完后 `src/bots` 的真实文件数）。
  它断言的是"这个目录还剩几个文件"，文件数因搬运而变，不改就是假红。**除这类目录计数外，任何断言仍不得改动**，
  且改动必须在报告里单独披露。Task 5 会把 canary 重写成终态口径（`CORE ≥11 / SRC_BOTS ≥2`），届时以 Task 5 为准
- 每个任务收尾**必须同时跑** `npm test` **和** `npm run build`（上一轮 eslint `no-undef` 让 vitest 全绿而构建炸机的教训，spec A9）
- 持久化载荷格式**零迁移**：键 `kuoluosaigai:bots:v1`、`{version:1, providers, bots(剥 rt), lifetime}` 结构一字不改
- 沿用协议护栏：发言 ≤10 条/分/连接、单条 ≤280 字、房间 ≤100 人、history-res ≤200 条（本阶段不改协议）
- 人机硬隔离红线（spec B2/B18）继续成立：bot 侧不得 import `useChat` / `roomCache` / `roomList` / `*.vue` / `../composables/**`
- `bot-core` 内**禁止**出现 `localStorage` / `sessionStorage` / `document.` / `window.`（`globalThis.WebSocket`/`globalThis.fetch` 作为**默认值**允许保留，宿主一律注入覆盖）
- eslint 已配 `globals: { globalThis: "readonly" }`，勿删（历史构建失败根因）
- commit message 用仓库现有 conventional commits 风格（`refactor(bots): …`），并按环境要求以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾

---

## Review Focus

计划里各任务的测试覆盖不到的、最容易在纯搬运中静默坏掉的东西：

1. **搬运让构建炸掉而测试全绿**（lint/解析差异）—— 每个任务的收尾步骤都显式跑 `npm run build`，Task 6 再跑一次并检查 `dist/` 产物里含 core 符号
2. **`bot-core` 残留浏览器全局，只在 Node/daemon 里炸**，jsdom 有 `localStorage` 所以测试永远照不出来 —— Task 5 用静态检查器（`@vitest-environment node`）钉死，Task 4 用真正的 node 环境测试作为运行时对照证据
3. **适配层丢掉 `deps.createLease` 注入点** —— 现有 `botStore.test.js` 全靠假租约；`createDeck` 改成接收 `lease` **实例**后，适配层必须仍从 `deps.createLease` 构造它。Task 4 有一条专门的回归断言
4. **隔离检查器退化成空扫描**（`src/bots` 只剩 2 个文件后仍能"全绿"）—— Task 5 保留并加强"确实扫到了 N 个文件"的反空跑断言，且扫描面扩到两个目录
5. **`historyMerge` 搬断人类侧** —— `useChat` 是真人聊天路径，import 一错就是聊天室回归。Task 2 要求 `tests/historyMerge.test.js` 与 `tests/useChat.test.js` 原样全绿并加一条跨侧可达性断言

---

## 目标文件结构

```
packages/bot-core/
  package.json          kuoluosaigai-bot-core / type:module / exports ./index.js
  index.js              包唯一出口（barrel），列出全部公开符号
  buffer.js             ← git mv src/bots/buffer.js          环形缓冲，零改动
  rhythm.js             ← git mv src/bots/rhythm.js          拟人节奏 + 家族闲置调度，零改动
  prompt.js             ← git mv src/bots/prompt.js          人格模板 + messages 组装，零改动
  llm.js                ← git mv src/bots/llm.js             OpenAI 兼容客户端，零改动
  connection.js         ← git mv src/bots/connection.js      薄 WS 层，零改动
  runner.js             ← git mv src/bots/runner.js          单 bot 编排，仅改 1 行 import
  historyMerge.js       ← git mv src/chat/historyMerge.js    P2 依赖，零改动（见 §核心洞察 2）
  timing.js             ← 新，HEARTBEAT_MS 单点定义（R3）
  deck.js               ← 新，store.js 的全部编排逻辑搬进来 + 3 端口参数化
src/
  bots/store.js         退化为浏览器适配层：注入 reactive/lease/getOwnerNick + 再导出常量
  bots/lease.js         留在浏览器侧（localStorage 跨标签互斥，daemon 不需要）；HEARTBEAT_MS 改为从 core 再导出
  chat/                 historyMerge.js 被搬走，其余（roomCache/roomList/rulesContent）不动
  composables/useChat.js   改 1 行 import
  components/BotDeck.vue   不改（常量经 store.js 再导出）
tests/
  historyMerge.test.js / botBuffer.test.js / botRhythm.test.js / botPrompt.test.js
  botLlm.test.js / botConnection.test.js / botRunner.test.js   各改 1 行 import 路径
  botStore.test.js                          断言禁止改动、仅 :9 import 路径随搬包（R1）——回归证据
  botIsolation.test.js                                         改造成双作用域检查器
  botDeckCore.test.js                                          新增，node 环境
```

---

## Task 1: workspace 骨架 + 搬 6 个纯 bot 模块进 `packages/bot-core`

**Files:**
- Modify: `package.json`（`workspaces` 字段）
- Create: `packages/bot-core/package.json`
- Create: `packages/bot-core/index.js`
- Move: `src/bots/{buffer,rhythm,prompt,llm,connection,runner}.js` → `packages/bot-core/`
- Modify: `packages/bot-core/runner.js:33`（唯一一处 import 改写）
- Modify: `src/bots/store.js:22-24`
- Modify: `tests/{botBuffer,botRhythm,botPrompt,botLlm,botConnection,botRunner}.test.js` 各自 import 行
- Modify: `tests/botStore.test.js:9`（**仅此一行**，`createIdleScheduler` 的来源路径；R1）
- Test: 无新增断言——**本任务的测试就是既有 362 个用例必须全绿，且断言零改动**

**Interfaces:**
- Consumes: 无
- Produces: npm 包名 `kuoluosaigai-bot-core`，出口 `index.js` 导出
  `createContextBuffer` `createRhythm` `trailingFamilyStreak` `RHYTHM_DEFAULTS` `createIdleScheduler`
  `buildSystemPrompt` `buildMessages` `clampText` `MAX_TEXT` `IDLE_KICK`
  `chatCompletion` `LlmError` `createBotConnection` `createBotRunner`
  **实际出口为 16 个符号**（Task 1 审查后校正）：另含 `SYSTEM_TEMPLATE` `BOT_BACKOFF`——
  `exports` 映射封死了深层 import，这两个常量被 `botPrompt.test.js`/`botConnection.test.js` 消费，
  不导出就只能改断言。**它们自此是永久公开面**，Task 4/P1 按这份 16 符号清单冻结，不按原 14。

- [ ] **Step 1: 建骨架**

`package.json` 的 `workspaces` 从 `["server"]` 改为 `["server", "packages/*"]`。

新建 `packages/bot-core/package.json`：

```json
{
  "name": "kuoluosaigai-bot-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js" }
}
```

- [ ] **Step 2: `git mv` 六个文件**

```bash
for f in buffer rhythm prompt llm connection runner; do git mv "src/bots/$f.js" "packages/bot-core/$f.js"; done
```

用 `git mv` 而非剪切粘贴，让 diff 显示为 rename（reviewer 只该看到 1 行改动）。

- [ ] **Step 3: 改 `packages/bot-core/runner.js` 的唯一外部依赖**

`../chat/historyMerge` → **本任务暂不动**（`historyMerge` 还在 `src/chat/`，Node 侧解析不了但 webpack 能）。
若此步导致 Node 侧 import 检查（Step 7）失败，属预期——**Step 7 允许标为已知失败**，Task 2 修好。
把失败现象记进 commit message，别顺手提前搬 `historyMerge`。

- [ ] **Step 4: 写 barrel `packages/bot-core/index.js`**

按 Interfaces 列的符号逐个 `export { … } from './xxx.js'`。显式列举、不用 `export *`——
`export *` 会让"core 的公开面"没有单一权威清单，Task 4 的适配层与 P1 的 daemon 都靠这张清单。

- [ ] **Step 5: 改所有消费方的 import**

`src/bots/store.js` 三行改为从包名导入：

```js
import { createIdleScheduler } from 'kuoluosaigai-bot-core'
import { createBotRunner } from 'kuoluosaigai-bot-core'
import { createTabLease, HEARTBEAT_MS } from './lease'
```

`tests/` 七个文件：`../src/bots/<mod>` → `kuoluosaigai-bot-core`（用 `grep -rl "src/bots/" tests/` 找全，逐个改，勿 sed 批量——`tests/botStore.test.js` 和 `tests/App.test.js` 里 `src/bots/store` 的引用**必须保持**，它们是适配层的合法消费方）。
其中 `tests/botStore.test.js` **只改 `:9` 一行**（`createIdleScheduler` 的来源），`:10` 那行 `createTabLease, LEASE_KEY, HEARTBEAT_MS, STALE_MS from '../src/bots/lease'` 不动（`lease.js` 留在原处），其余一律不动（R1）。

- [ ] **Step 6: 装 workspace 链接**

```bash
npm install
```
Expected: 无 EALLOWREMOTE / registry 报错（服务器与本机的 lockfile 统一 npmmirror 的历史坑，见 spec §9），
`node_modules/kuoluosaigai-bot-core` 是指向 `packages/bot-core` 的链接。

- [ ] **Step 7: 验证**

```bash
npm test          # Expected: 362 全绿，用例数不变，断言零改动
npm run build     # Expected: 编译成功，dist/ 产出
node --input-type=module -e "import('kuoluosaigai-bot-core').then(m => console.log(Object.keys(m).length))"
```
第三条在 Task 1 **可能**因 `runner.js → ../chat/historyMerge` 失败（Task 2 修）；失败就把命令与报错贴进 commit message，通过则更好。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(bots): 抽 packages/bot-core 工作区包，搬 6 个纯模块出 src"
```

---

## Task 2: 把 `historyMerge` 搬进 core（打通 Node 侧解析）

**Files:**
- Move: `src/chat/historyMerge.js` → `packages/bot-core/historyMerge.js`
- Modify: `packages/bot-core/runner.js:33`
- Modify: `src/composables/useChat.js:2`
- Modify: `tests/historyMerge.test.js:2`
- Modify: `packages/bot-core/index.js`（追加导出）
- Test: `tests/historyMerge.test.js`、`tests/useChat.test.js` 原样全绿 + 新增 1 条跨侧可达性用例

**Interfaces:**
- Consumes: `kuoluosaigai-bot-core`（Task 1）
- Produces: barrel 新增 `mergeHistory`

- [ ] **Step 1: 写失败测试**

在 `tests/historyMerge.test.js` 末尾追加（保持原文件其余内容一字不改）：

```js
import fs from 'node:fs'
import path from 'node:path'

describe('P0 搬包：跨侧可达性（Review Focus 5）', () => {
  it('core 包出口提供 mergeHistory', async () => {
    const core = await import('kuoluosaigai-bot-core')
    expect(typeof core.mergeHistory).toBe('function')
  })

  // 单一实现的保证走文件系统，不依赖打包器的模块实例同一性（R2）：
  // 老路径一旦消失，就不可能存在"src 侧还有一份在跑"的分叉。
  it('src/chat/historyMerge.js 已不存在（杜绝两份实现漂移，spec A8）', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), 'src/chat/historyMerge.js'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑到失败**

```bash
npx vitest run tests/historyMerge.test.js
```
Expected: FAIL —— `Cannot find package 'kuoluosaigai-bot-core'` 或 `core.mergeHistory is not a function`

- [ ] **Step 3: 搬运并改四处引用**

```bash
git mv src/chat/historyMerge.js packages/bot-core/historyMerge.js
```
**R7：Node ESM 不解析无扩展名相对路径**——`packages/bot-core/runner.js:28-33` 六条 specifier **全部补 `.js`**
（现状 `./buffer` `./rhythm` `./prompt` `./llm` `./connection` 五条无扩展名，第六条是爬回 `../../src/chat/historyMerge` 的那条）。
`:33` 改为 `import { mergeHistory } from './historyMerge.js'`。漏掉任何一条，Step 5 的 node 检查就恒红，
而 webpack/vitest 都能解析无扩展名——**只有真 Node 会炸，Node 恰是 P1 daemon 的宿主**，所以这是假绿陷阱。
其余三处引用照改：`src/composables/useChat.js:2` → `import { mergeHistory } from 'kuoluosaigai-bot-core'`；
`tests/historyMerge.test.js:2` → `import { mergeHistory } from 'kuoluosaigai-bot-core'`；
`packages/bot-core/index.js` 追加 `export { mergeHistory } from './historyMerge.js'`。

`src/chat/roomCache.js:6` 与 `src/composables/useChat.js:94` 的注释里提到 `historyMerge` —— 注释不是依赖，**别改**（改了会让 `botIsolation` 的"注释不误报"用例失去样本；Task 5 依赖它）。

- [ ] **Step 4: 跑到通过**

```bash
npx vitest run tests/historyMerge.test.js tests/useChat.test.js tests/botRunner.test.js
```
Expected: PASS（原有用例数不减）

- [ ] **Step 5: Node 侧解析终于应当可用**

```bash
node --input-type=module -e "import('kuoluosaigai-bot-core').then(m => console.log(Object.keys(m).sort().join(',')))"
```
Expected: 打印符号列表，**无 SyntaxError**（这条就是 Task 1 Step 3 记录的那个已知失败的解药）

- [ ] **Step 6: 收尾 + Commit**

```bash
npm test && npm run build
git add -A && git commit -m "refactor(bots): historyMerge 入 core，Node 侧解析打通"
```

---

## Task 3: `lease` 端口 + `createNullLease`

**Files:**
- Create: `packages/bot-core/timing.js`（`HEARTBEAT_MS` 单点定义，R3）
- Create: `packages/bot-core/deck.js`（本任务只放 `createNullLease` 与契约注释，Task 4 才装主体）
- Modify: `packages/bot-core/index.js`
- Modify: `src/bots/lease.js:14`（改为从 core 再导出 `HEARTBEAT_MS`，自身不再定义）
- Test: `tests/botDeckCore.test.js`（新建，文件头写 `// @vitest-environment node`）

**Interfaces:**
- Consumes: 无
- Produces:
  ```js
  // packages/bot-core/timing.js
  export const HEARTBEAT_MS = 15000   // 全局 tick 与租约心跳的共用权威周期（终审 M4）
  ```
  ```js
  createNullLease(): {
    acquire: (botId: string) => Promise<true>,
    release: (botId: string) => void,
    releaseAll: () => void,
    heartbeat: (botId: string) => void,
    isHeldElsewhere: (botId: string) => false,
    degraded: false,
  }
  ```
  契约与 `src/bots/lease.js` 的 `createTabLease` 返回值**同名同形**——`deck.js` 只认这六个成员，
  多出来的一律不依赖。

- [ ] **Step 1: 写失败测试**

`tests/botDeckCore.test.js`：

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createNullLease } from 'kuoluosaigai-bot-core'

describe('lease 端口（daemon 用恒真实现）', () => {
  it('本测试跑在 node 环境：没有浏览器全局（Review Focus 2 的前提）', () => {
    expect(typeof globalThis.localStorage).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
  })

  it('六个成员齐备且语义恒真', async () => {
    const l = createNullLease()
    expect(await l.acquire('bot-0')).toBe(true)
    expect(l.isHeldElsewhere('bot-0')).toBe(false)
    expect(l.degraded).toBe(false)
    expect(() => { l.release('bot-0'); l.releaseAll(); l.heartbeat('bot-0') }).not.toThrow()
  })

  it('与浏览器 createTabLease 同名同形（端口契约，不是两套实现）', async () => {
    const { createTabLease } = await import('../src/bots/lease.js')
    const browser = createTabLease({ storage: new Mapish() })
    const nulls = createNullLease()
    expect(Object.keys(nulls).sort()).toEqual(
      ['acquire', 'release', 'releaseAll', 'heartbeat', 'isHeldElsewhere', 'degraded'].sort())
    for (const k of ['acquire', 'release', 'releaseAll', 'heartbeat', 'isHeldElsewhere']) {
      expect(typeof browser[k], `浏览器侧缺 ${k}`).toBe('function')
    }
  })
})
```

`new Mapish()` —— 测试文件内自建一个 6 行的 `{getItem,setItem,removeItem}` Map 封装
（`src/bots/lease.js` 的 storage 注入契约就是这三个方法；别引入新测试依赖）。

- [ ] **Step 2: 跑到失败**

```bash
npx vitest run tests/botDeckCore.test.js
```
Expected: FAIL —— `createNullLease is not exported from 'kuoluosaigai-bot-core'`

- [ ] **Step 3: 实现 `createNullLease` 与 `timing.js`**

`createNullLease` 放进 `packages/bot-core/deck.js` 并从 barrel 导出。实现约 10 行；`degraded` 用**值**而非 getter 也行，
但 `deck.js` 里读的是 `lease.degraded`，两种都兼容。

同一步把 `HEARTBEAT_MS` 单点化（R3）：新建 `packages/bot-core/timing.js` 定义 `export const HEARTBEAT_MS = 15000`，
`src/bots/lease.js:14` 的 `export const HEARTBEAT_MS = 15000` 换成
`export { HEARTBEAT_MS } from 'kuoluosaigai-bot-core'`（值一字不改，`tests/botLease.test.js:32` 的 `toBe(15000)` 必须仍然绿——
它就是"没有把常量抄成两份"的证据）。`STALE_MS` 是租约私有语义，**留在 `lease.js` 不动**。

- [ ] **Step 4: 跑到通过 + 收尾**

```bash
npx vitest run tests/botDeckCore.test.js
npm test && npm run build
git add -A && git commit -m "feat(bots): core 增 lease 端口与 createNullLease"
```

---

## Task 4: `store.js` 一刀切分 —— core `deck.js` + 浏览器适配层

**Files:**
- Modify: `packages/bot-core/deck.js`（承接 `store.js:62-652` 的全部逻辑主体）
- Modify: `packages/bot-core/index.js`
- Modify: `src/bots/store.js`（重写成约 30 行适配层）
- Test: `tests/botDeckCore.test.js` 追加用例；`tests/botStore.test.js` **断言禁止修改**（R1），它是指纹级回归证据

**Interfaces:**
- Consumes: `createNullLease`（Task 3）
- Produces:
  ```js
  createDeck(opts) -> store   // 与今日 createBotStore 返回值同形
  opts = {
    storage,                   // 必需，{getItem,setItem,removeItem}；缺失 → throw TypeError
    lease = createNullLease(), // Task 3 契约
    reactiveImpl = (o) => o,   // 浏览器传 vue 的 reactive；Node 传恒等
    getOwnerNick = () => null, // 取代 sessionStorage 'kuoluosaigai:nick' 直读
    wsUrl = '', rng = Math.random, now = Date.now,
    deps = {},                 // { createRunner, createScheduler, tabId, sleep, WebSocketImpl }
  }
  // 同形返回：providers / bots / lifetime / storageDegraded / leaseDegraded(getter)
  // addProvider updateProvider removeProvider
  // addBot updateBot removeBot
  // startBot stopBot switchBotRoom clearBotBuffer refreshLeases getBuffer
  // load persist dispose
  ```
  常量也从 core 出口：`CONFIG_KEY` `SCHEMA_VERSION` `MAX_BOTS` `PROVIDER_PRESETS`

- [ ] **Step 1: 写失败测试（追加到 `tests/botDeckCore.test.js`）**

四条，各自独立成 `it`：

```js
// (a) 零浏览器全局可用：Map storage + 恒等 reactive + null lease，起一个 bot 不炸
it('纯 Node 环境下 addBot→persist→load roundtrip，载荷键与格式不变', async () => {
  const storage = new Mapish()
  const deck = createDeck({ storage })
  deck.addProvider({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' })
  deck.addBot({ name: '小李', persona: 'p', chattiness: 50, roomId: 'nebula' })
  expect(storage.getItem('kuoluosaigai:bots:v1')).toBeTruthy()
  const payload = JSON.parse(storage.getItem('kuoluosaigai:bots:v1'))
  expect(payload.version).toBe(1)
  expect(Object.keys(payload).sort()).toEqual(['bots', 'lifetime', 'providers', 'version'])
})

// (b) reactiveImpl 被真的用上（不是留在 core 里的 import）
it('reactiveImpl 收到 store 字面量，且方法都在其后', async () => {
  const seen = []
  createDeck({ storage: new Mapish(), reactiveImpl: (o) => { seen.push(o); return o } })
  expect(seen).toHaveLength(1)
  expect(typeof seen[0].startBot).toBe('function')
})

// (c) null lease 下 startBot 直通，不置 otherTab
it('null lease：startBot 成功、rt.otherTab 恒 false', async () => {
  const started = []
  const deck = createDeck({
    storage: new Mapish(),
    deps: { createRunner: (o) => { started.push(o.bot.id); return fakeRunner() } },
  })
  deck.addBot({ id: 'bot-0', name: '小李', providerId: null, roomId: 'nebula' })
  expect(await deck.startBot('bot-0')).toBe(true)
  expect(started).toEqual(['bot-0'])
  expect(deck.bots[0].rt.otherTab).toBe(false)
  deck.dispose()   // startBot 会 ensureTick() 起 setInterval；node 环境不留活句柄（R4）
})

// (d) storage 缺失明确报错，别静默用 globalThis.localStorage
it('不传 storage → TypeError（禁止 core 摸浏览器全局）', () => {
  expect(() => createDeck({})).toThrow(/storage/)
})
```

`fakeRunner()` —— 测试内自建，返回 `{ start(){}, stop(){}, switchRoom(){}, clearBuffer(){}, getBuffer(){return []}, idleEligible(){return false}, idleRoll(){return false}, pokeIdle(){} }`
（这九个方法就是 `deck.js` 对 runner 的全部调用面，照 `store.js` 现状取齐）。

- [ ] **Step 2: 跑到失败**

```bash
npx vitest run tests/botDeckCore.test.js
```
Expected: FAIL —— `createDeck is not exported`

- [ ] **Step 3: 做切分（一次原子提交，不留两份实现）**

把 `src/bots/store.js:26-652` 整段搬进 `packages/bot-core/deck.js`，**只**做以下五处机械替换，
其余逻辑（含所有竞态注释与终审修复）**一行都不许动**：

| 原 | 改后 |
|---|---|
| `import { reactive } from 'vue'` | 删；改用参数 `reactiveImpl`，`const store = reactiveImpl({...})` |
| `import { createTabLease, HEARTBEAT_MS } from './lease'` | `createTabLease` **整条删除**（租约改由 `opts.lease` 注入，见下一行）；`HEARTBEAT_MS` 改为 `import { HEARTBEAT_MS } from './timing'`（Task 3 R3 已单点化）。**不得**在 `deck.js` 里另立 `TICK_MS = 15000`——那会把终审 M4 修掉的"两个 15000 巧合同值"重新请回来 |
| `const lease = createLease({storage, tabId, now, sleep})` | `const lease = opts.lease`（**不再在 core 里造租约**） |
| `storage = globalThis.localStorage` 等默认值 | 参数化，`storage` 缺失即 `throw new TypeError('deck: storage required')` |
| `getOwnerNick()` 读 `ss.getItem('kuoluosaigai:nick')` | `getOwnerNick = () => null` 参数，函数体搬适配层 |

`src/bots/store.js` 重写成适配层（**签名与今日完全一致**，`tests/botStore.test.js` 一字不改）：

```js
export { CONFIG_KEY, SCHEMA_VERSION, MAX_BOTS, PROVIDER_PRESETS } from 'kuoluosaigai-bot-core'

export function createBotStore({
  wsUrl = '', storage = globalThis.localStorage, sessionStorage: ss = globalThis.sessionStorage,
  rng = Math.random, now = Date.now, deps = {},
} = {}) {
  return createDeck({
    wsUrl, storage, rng, now, deps,               // deps 原样透传（含 createRunner/createScheduler/sleep/WebSocketImpl）
    reactiveImpl: reactive,
    lease: (deps.createLease || createTabLease)({ storage, tabId: deps.tabId, now, sleep: deps.sleep }),
    getOwnerNick: () => { try { const v = ss.getItem(OWN_NICK_KEY); return typeof v === 'string' && v ? v : null } catch { return null } },
  })
}
```

`OWN_NICK_KEY = 'kuoluosaigai:nick'` 留在适配层（浏览器专属存储键，core 不该知道）。

- [ ] **Step 4: 跑到通过（本任务的主证据）**

```bash
npx vitest run tests/botDeckCore.test.js
```
Expected: PASS 全部（含新增 4 条）

- [ ] **Step 5: 回归证据 —— 未改动的旧测试**

```bash
git diff main -- tests/botStore.test.js   # Expected: 只有 Task 1 那行 `:9` import 路径；断言/用例区零 diff（R1）
npx vitest run tests/botStore.test.js tests/BotDeck.test.js tests/BotCard.test.js tests/App.test.js
```
Expected: 全绿。`botStore.test.js` 里的假 `deps.createLease` 用例如果挂了，几乎一定是
适配层丢了 `deps.createLease` → **Review Focus 3 命中**，修适配层，别改测试。

- [ ] **Step 6: 收尾 + Commit**

```bash
npm test && npm run build
git add -A && git commit -m "refactor(bots): store 一刀切分为 core/deck + 浏览器适配层"
```

---

## Task 5: 分层依赖检查器改造（core 纯度 + 双作用域反空跑）

**Files:**
- Modify: `tests/botIsolation.test.js`
- Test: 同上（自身即测试）

**Interfaces:**
- Consumes: Task 1–4 的最终目录形状
- Produces: `findIsolationViolations(source, rules)`（新增第二参）、`findCorePurityViolations(source)`

- [ ] **Step 1: 写失败测试**

在现有两个 `describe` 之外追加：

```js
describe('P0 分层规则', () => {
  it('core 规则额外禁止 vue；适配层规则允许 vue', () => {
    const vueSrc = `import { reactive } from 'vue'`
    expect(findIsolationViolations(vueSrc, CORE_RULES)).toContain(
      expect.objectContaining({ label: 'vue' }))
    expect(findIsolationViolations(vueSrc, ADAPTER_RULES)).toEqual([])
  })

  it('core 纯度：localStorage/sessionStorage/document./window. 一律违规', () => {
    const cases = [
      `const s = globalThis.localStorage`,
      `ss.getItem('kuoluosaigai:nick')`,
      `document.title = 'x'`,
      `window.addEventListener('storage', h)`,
    ]
    for (const src of cases) expect(findCorePurityViolations(src), src).not.toEqual([])
  })

  it('globalThis.WebSocket / globalThis.fetch 作为默认值合法（宿主注入覆盖，勿误报）', () => {
    const src = `export function createBotConnection({ WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch } = {}) {}`
    expect(findCorePurityViolations(src)).toEqual([])
  })

  it('注释里出现禁词不误报（沿用现规则精神）', () => {
    expect(findCorePurityViolations(`// 不碰 localStorage，也不 import vue\nimport './deck.js'`)).toEqual([])
  })
})

describe('实际扫描（反空跑，Review Focus 4）', () => {
  it('packages/bot-core 与 src/bots 都确实扫到文件，且数量下限达标', () => {
    expect(jsFiles(CORE_DIR).length).toBeGreaterThanOrEqual(11)  // 8 模块 + index + deck + timing（R5）
    expect(jsFiles(SRC_BOTS_DIR).length).toBeGreaterThanOrEqual(2)  // store.js + lease.js
  })

  it('core 下每个文件既过隔离规则又过纯度规则', () => {
    for (const f of jsFiles(CORE_DIR)) {
      const src = fs.readFileSync(f, 'utf8')
      expect(findIsolationViolations(src, CORE_RULES), f).toEqual([])
      expect(findCorePurityViolations(stripComments(src)), f).toEqual([])
    }
  })

  it('src/bots 适配层过隔离规则但豁免 vue', () => {
    for (const f of jsFiles(SRC_BOTS_DIR)) {
      expect(findIsolationViolations(fs.readFileSync(f, 'utf8'), ADAPTER_RULES), f).toEqual([])
    }
  })
})
```

- [ ] **Step 2: 跑到失败**

```bash
npx vitest run tests/botIsolation.test.js
```
Expected: FAIL —— `CORE_RULES is not defined` / `findCorePurityViolations is not defined`

- [ ] **Step 3: 改造检查器**

要点，别扩大范围：

- 把现有 `FORBIDDEN` 数组变成 `ADAPTER_RULES`，`CORE_RULES` = 它 + `{ label: 'vue', re: /\bvue\b/ }`
  + `{ label: 'kuoluosaigai-bot-core 自引用', re: /kuoluosaigai-bot-core/ }`（core 不得 import 自己）
- `findCorePurityViolations(source)`：先 `stripComments(source)`（去 `//` 行注释与 `/* */` 块注释，
  **保留字符串**——`'kuoluosaigai:roomCache:v2'` 这类键名不得误报），
  再匹配 `localStorage|sessionStorage|\bdocument\.|\bwindow\.`
- `BOTS_DIR` 拆成 `CORE_DIR = path.resolve(process.cwd(), 'packages/bot-core')` 与 `SRC_BOTS_DIR`
- 保留原有 `findIsolationViolations` 自检用例（含那条"注释里的边界说明不误报"）不动——
  它是回归锚

- [ ] **Step 4: 跑到通过 + 收尾**

```bash
npx vitest run tests/botIsolation.test.js
npm test && npm run build
git add -A && git commit -m "test(bots): 分层依赖检查器——core 禁 vue/浏览器全局，反空跑扩到双目录"
```

---

## Task 6: P0 验收 —— 产物、文档、spec 修正

**Files:**
- Modify: `README.md`（项目结构 + 技术栈表）
- Modify: `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md`（§7 与 §7.4）
- Test: 手工浏览器冒烟 + 构建产物抽查

**Interfaces:**
- Consumes: Task 1–5 全部
- Produces: 可交付的 P0 基线（P4/P1 都从此起跑）

- [ ] **Step 1: 浏览器手工冒烟（唯一能证明"行为逐字节不变"的手段）**

```bash
npm run dev
```
逐项验：BOT DECK 入口打开 → 新建 provider + bot → 启动 bot 进公共房发言 →
观战窗有缓冲 → 刷新页面后配置仍在（localStorage 键未变）→ 第二个标签页开同一 bot 显示"他处运行"
（跨标签租约仍生效）。任一项失败回 Task 4 修，**不要**在文档里把 P0 记为完成。

- [ ] **Step 2: 产物抽查**

```bash
npm run build
grep -c "kuoluosaigai:bots:v1" dist/js/*.js
```
Expected: ≥1（core 确实进了 bundle）

- [ ] **Step 3: 更新 README**

技术栈表下加一行说明 `packages/bot-core` 的定位（浏览器面板与 `saigai-bot` daemon 共用的宿主无关核心）；
项目结构块补 `packages/bot-core/` 条目；`npm test` 那句的用例数按实际输出改（≥362）。
README 里"部署模型不变"这句话仍然成立——P0 不产生新的部署形态，明写出来免得读者误会。

- [ ] **Step 4: 修 spec §7**

`§7.4 单实例锁` 标注"改由 P1 daemon 承担，`node:fs` 不得进 bot-core（浏览器打包会把它拖进 bundle）"；
`§7.1 现状盘点` 表格补一行 `src/chat/historyMerge.js`（runner 的真实依赖，随 core 搬走），
并在 §7.2 加一句"实现采 `reactiveImpl` 注入而非 plain-state + onChange，原因是今日闭包大量直接改 `store.x`，
换成 onChange 会重写全部变更点并破坏 A/B 方案里唯一没被终审打磨过的部分"。
`§12` 无变化。**改 spec 只改这两处，别顺手改需求。**

- [ ] **Step 5: 全量收尾**

```bash
npm test && npm run build && npm run lint
```
Expected: 三者全绿（lint 是第三道保险，A9 教训）

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs(p0): bot-core 抽包验收——README/spec 校正"
```

---

## 完成定义（P0 DoD）

1. `packages/bot-core` 是独立 workspace 包、`type: module`，**纯 Node 下可 import 且无 SyntaxError**（Task 2 Step 5）
2. core 内**零** Vue / DOM / `localStorage` 依赖，由自动化检查器钉住（Task 5）
3. `tests/botStore.test.js` **断言零改动**仍然全绿（仅 `:9` import 路径随搬包变更，R1）—— 浏览器行为未回归的最强证据（Task 4 Step 5）
4. 组件层 `BotDeck.vue` / `BotCard.vue` / `App.vue` **零改动**（常量经适配层再导出）
5. 测试总数 ≥362 且 `npm test` / `npm run build` / `npm run lint` 三绿（Task 6 Step 5）
6. P1 daemon 需要的注入面已就位：`createDeck({storage, lease, reactiveImpl, getOwnerNick, wsUrl, deps})`
