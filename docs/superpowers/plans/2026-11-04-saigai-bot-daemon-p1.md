# P1 `saigai-bot` daemon MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可独立常驻的 Node 运行时 `saigai-bot`：读 ESM 配置文件、驱动 `packages/bot-core` 的同一份 bot 逻辑连进聊天房，支持配置热重载、单实例锁、成本刹车、结构化日志与 `doctor`/`status` 子命令。

**Architecture:** 新建 `packages/bot-daemon`（`kuoluosaigai-bot-daemon`）作为 core 的第二个宿主——它只负责"壳"（配置 loader、state.json 存储适配器、进程锁、watcher、CLI、日志、本地控制口），一切 bot 行为仍由 `createDeck` 里的唯一一份实现驱动（A8 禁 core 分叉）。为此 core 侧先加两个**浏览器可选择不启用**的可选输入：宿主 `onEvent('error'|'warn')` 观测端口与 `schedule` 刹车端口。

**Tech Stack:** Node ≥22 ESM、`node:` 内建（`fs`/`path`/`http`/`crypto`/`os`）、原生 `globalThis.WebSocket`、vitest（daemon 侧独立 `environment: 'node'` 工程）。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md`（§8 为主体；**§16.5 的 Q1/Q2/Q3/Q7/Q9/Q10/Q11/Q12 与前文冲突时以 §16.5 为准**，本计划已据其裁定）

## Global Constraints

- **不引 `ws`**：daemon 用 `globalThis.WebSocket`（Node 24 已由 `tests/botCoreNodeE2e.test.js` 实测可连真 `server/`），`packages/bot-daemon/package.json` 写 `engines: { "node": ">=22" }`（裁定 D1，spec G8 的"允许 ws"读作许可而非要求）。
- **零新增运行时依赖**：daemon 只用 `node:` 内建；`packages/bot-core` **继续禁 `node:` 内建、禁 vue、禁浏览器全局**（`tests/botIsolation.test.js` 的 `CORE_DIR` 只扫 `packages/bot-core`，新包不受其约束，也**不得**把 daemon 文件加进该扫描目录）。
- **协议护栏全量沿用多房间轮**：发言 ≤10 条/分/连接、单条 ≤280 字、房间 ≤100 人、`history-res` ≤200 条、切房 20 次/分。
- **昵称只能是 `ANON-XXXX`**；bot 人格名 ≤12 字（`normalizeCfg` 已截断，不得放宽）。
- **测试基线只增不减**：现状 388（349 客户端 + 39 服务端）。收尾质量门是**三道**：`npm test`、`npm run build`、`npm run lint`（A9，上上轮 globalThis 教训）。
- **A1/A3 key 红线**：完整 `apiKey` 只允许出现在 `fetch` 的 `Authorization` 头。它**不得**进入 `state.json`、stdout 日志、`status` 响应、错误消息。
- **G3/Q10 收敛口径**：检测后 ≤2s 完成收敛；默认**轮询 1000ms + debounce 500ms**，端到端最坏 ≈3.5s。
- **命名（用户拍板）**：CLI `saigai-bot`、包名 `kuoluosaigai-bot-daemon`、配置文件 `saigai-bot.config.js`。
- **数据目录**默认 `os.homedir()/.config/saigai-bot/`，`--data-dir` 覆盖；目录内文件：`saigai-bot.lock`、`state.json`、`rpc.json`。
- **daemon 不落聊天记录**（§3）：会话缓冲仍是纯内存，重启靠 P2P 历史重建。
- **daemon 永不写配置文件**（Q2）；配置是用户手写的，回写会毁注释并自触发 watcher。
- **单房钉死**（Q1）：一 bot = 一连接 = 一房，配置字段是 `room`（字符串），不是 `rooms` 数组。
- **裁定 R20（跨阶段约束，本计划不实现但必须先定；Task 5 审查 Minor #3 引出）**：core 的
  `switchBotRoom` 会写 `item.roomId` 并 `persist()`，而 `state.json` 的**权威形状只有
  `bots:[{id,nick}]`**（Q2 把 room 划归"定义"）。P1 内没有任何 daemon 面会调 `switchBotRoom`
  （CLI 无此子命令、`status` 只读），所以**当下无损失**；但 spec **Q1** 把 `bot.switchRoom` 放进了
  **P3** 的指令白名单 —— 届时手机改的房会在**下次重启蒸发**、bot 回到配置声明的房，且操作者无从得知。
  P3 实现时必须二选一并写进文档：**(a) 把切换后的房作为 state 拥有的覆盖项持久化**
  （扩 `state.json` 形状为 `bots:[{id,nick,room?}]`，与 nick 同属"运行时可变身份"，
  配置声明值降级为首次默认）；或 **(b) 明令 daemon 侧房间为只读、拒绝 `bot.switchRoom`**。
  我倾向 **(a)**：(b) 会让 P3 的一个宣称能力凭空消失。无论选哪条，Task 7 的 `snapshot()` 都要显示
  **有效房**而非配置房，否则 `status` 会自证清白地撒谎。
- **`id` 必填且稳定**（Q3）：`[a-z0-9-]{1,32}`，`doctor` 校验唯一；改名=变更、只有 `id` 增删才是增删。
- **lint 兼容**：`packages/` 在 eslint 覆盖范围内（`lint` = `vue-cli-service lint src tests packages`），故 daemon 代码**不得使用顶层 await**、不得使用 `??=`/`||=` 等新赋值语法；入口一律 `async function main()` + `.then/.catch`。

## 共享 fixture（裁定 R6：Task 4 与 Task 13 双向钉形状，禁止跨边 import）

`config.js` 含 `node:` 内建，`src/bots/export.js` 属浏览器侧 —— **两侧不得互相 import**
（jsdom 里 import `node:fs` 会炸，daemon 测试里 import 带 vue 的代码同样炸）。形状漂移靠
**同一段文本**在两侧各自断言来防：以下这段是权威样例，Task 4 的 `config.test.js` 断言
`validateConfig` 接受它、Task 13 的 `botExport.test.js` 断言 `buildConfigFile` 产出的字符串
与之同形（用 `new Function` 解析比对，不 import 对方模块）：

```js
export default {
  name: 'lab-vm',
  serverUrl: 'wss://kuoluosaigai.com',
  provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.KUO_LLM_KEY, model: 'deepseek-chat' },
  limits: { globalHourlyMessages: 120, quietHours: { from: '01:30', to: '08:00' } },
  bots: [
    { id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula', chattiness: 70, temperature: 1.1, hourlyBudget: 20 },
  ],
}
```

## Review Focus

spec 未写成测试、但最可能咬到使用者的一类输入。每行在 owning task 里钉一条测试：

1. **配置文件里写了函数 / `import` 副作用 / 顶层 await** —— 期望 `doctor`/`validate` **拒绝并指出行位**，而不是"跑起来了但配置即 RCE 面"（§8.1 代价段；Task 4）。
2. **`apiKey` 流向盘/日志** —— deck 的 `persist()` 本来就把 `providers[].apiKey` 写进 storage（已核 `deck.js:496` + `PROVIDER_KEYS`）。期望 daemon 的存储适配器**落盘前剥 key**，日志与 `status` 同样只有后四位（Task 5、Task 11、Task 10）。
3. **陈旧锁的两种极端** —— 持有者 PID 已死要接管并打 WARN；PID 仍活着（哪怕是系统复用了同号 PID）绝不能抢，否则 systemd 平滑重启窗口里双进程同房互踩（A5；Task 6）。
4. **watcher 读到"消失/半写/清空"的配置** —— 期望保持上一次好配置继续跑，**不得**把全部 bot 停掉（A4 的最坏触发路径恰好是编辑器/磁盘的畸形写；Task 8）。
5. **静默窗与全局闸的合流** —— 期望静默窗内不主动发起、不接非点名的话；被 @ **可以**回，但点名回复同样计入 `globalHourlyMessages`，全局闸满则连点名也不发（Q9；Task 2、Task 3）。

---

### Task 1: core 观测端口 —— `onEvent('error'|'warn')` 转发给宿主（Q7）

**Files:**
- Modify: `packages/bot-core/runner.js`（非致命 LlmError 分支 `runner.js:261-265` 与重试路径）
- Modify: `packages/bot-core/deck.js`（`createDeck` 的 `deps` 增 `onEvent` 宿主汇；`handleEvent` 转发）
- Test: `tests/botRunner.test.js`、`tests/botDeckCore.test.js`

**Interfaces:**
- Consumes: 现有 runner 端口 `onEvent(type, payload)`，`type` 联合现含 `'activity'|'nick'|'stopped'`（`runner.js:64`）
- Produces:
  - `createBotRunner` 新发两类事件：`onEvent('error', { kind, message, fatal })`（`kind` 取 `LlmError.kind` ∈ `auth|rate|server|timeout|network|bad-response`；`message` 为 `LlmError.message`，**不含 key**）、`onEvent('warn', { reason })`（重试耗尽、`SLOW DOWN` 等降级）
  - `createDeck({ ..., deps: { onEvent?: (type, payload) => void } })`：宿主汇，收到 `(type, { botId, ...payload })`。缺省不传 → 行为与现状**逐字节一致**（浏览器侧 `src/bots/store.js` 本计划不改、不传）

- [ ] **Step 1: 写失败测试**（`tests/botRunner.test.js`）

```js
it('非致命 LlmError（429）→ onEvent("error", {kind:"rate", fatal:false})，且 message 不含 apiKey', ...)
it('auth 类错误 → onEvent("error", {kind:"auth", fatal:true}) 且照旧停用 bot', ...)
```
断言 `payload.message` 里 `apiKey` 的任何子串都不出现（用 `expect(json).not.toMatch(/KEY/)`)。

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/botRunner.test.js` Expected: FAIL（收不到 error 事件）
- [ ] **Step 3: 实现** — runner 在既有 catch 分支补 `onEvent?.('error', ...)`；`makeRunnerOpts` 之后 deck 的 `handleEvent` 末尾加"非活动类事件转发宿主汇"。`message` 一律取 `err.message`（B9 已保证不含 key），不得拼 `err.detail` 之外的原始响应体。
- [ ] **Step 4: 加 deck 层测试**（`tests/botDeckCore.test.js`）：注入 `deps.onEvent`，断言 `startBot` 后收到 `{ botId, kind:'rate' }`；不注入时不抛。
- [ ] **Step 5: 三道门 + 提交** — `npm test`（388+新增）、`npm run build`、`npm run lint` 全绿后
```bash
git add packages/bot-core tests/botRunner.test.js tests/botDeckCore.test.js
git commit -m "feat(core): onEvent 增 error/warn 观测端口并转发宿主（Q7，浏览器侧零行为变化）"
```

---

### Task 2: core 刹车端口 —— `schedule` 的静默窗与上线静默窗（Q9 + §12）

**Files:**
- Create: `packages/bot-core/schedule.js`（纯函数，无 IO）
- Modify: `packages/bot-core/deck.js`（`createDeck` 增 `schedule` 输入；闲置发起处 `onGlobalTick` 前置判定）
- Modify: `packages/bot-core/runner.js`（接 `gate` 端口，发送决策处判定）
- Test: `tests/botSchedule.test.js`（新）、`tests/botDeckCore.test.js`、`tests/botRunner.test.js`

**Interfaces:**
- Consumes: `RHYTHM_DEFAULTS.hourlyCap = 30`（`rhythm.js:27`，不改值）
- Produces:
  - `packages/bot-core/schedule.js`：`parseClock('01:30') -> {h, m}`（非法 → `null`）、`inQuietWindow(ts, {from, to}) -> boolean`（按**本机墙钟**，跨零点窗口正确；`from === to` 视为全时段静默）、`createGate({ now, quietHours, startupQuietMs, startedAt, hourAccountor? }) -> { quietNow(): boolean, allowSpeak(mentions: boolean): boolean }`（**`hourAccountor` 可选**：本任务先不生产它，缺省即"不做全局拦截"，Task 3 才造并接入 —— 预扫描裁定 R1，避免 T2 反向依赖 T3）
  - `createDeck({ ..., schedule?: { quietHours?: {from: string, to: string}, globalHourlyMessages?: number, startupQuietMs?: number } })`
  - `createBotRunner({ ..., gate?: { allowSpeak(mentions: boolean): boolean } })`；`gate` 缺省 → 现状行为

- [ ] **Step 1: 写失败测试**（`tests/botSchedule.test.js`，纯函数直接测）

```js
it('inQuietWindow：窗口 01:30–08:00，02:00 true、09:00 false')
it('跨零点窗口 23:00–06:00：01:00 true、12:00 false')  // 反例最易写错
it('from === to → 恒 true（全时段静默）')
it('parseClock("25:00") / "1:60" / "abc" → null')
it('startupQuietMs：上线 3 分钟内 allowSpeak(false) 为 false，点名 true')
```
用固定 `ts = Date.parse('2026-11-04T02:00:00')` 一类注入 `now`，别依赖真实时钟。

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/botSchedule.test.js` Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现 `schedule.js`** — `inQuietWindow` 内用 `new Date(ts)` 读 `getHours()/getMinutes()`（`Date` 非浏览器全局、非 `node:` 内建，core 纯度允许）。跨零点：`from <= to ? (cur>=from && cur<to) : (cur>=from || cur<to)`。
- [ ] **Step 4: 接进 deck 与 runner** — deck 建 `gate` 并经 `makeRunnerOpts` 透传；`onGlobalTick` 的闲置发起处先问 `gate.allowSpeak(false)`。`schedule` 未配置时**不得创建 gate**（保持浏览器零变化），并加一条断言测试：`createDeck({})` 路径下 runner 收到的 `gate` 为 `undefined`。
- [ ] **Step 5: 回归护栏测试**（`tests/botDeckCore.test.js`）：不传 `schedule` → 冷场闲置仍能发起（现有用例语义不变）；传 `quietHours` 覆盖当前时刻 → 闲置**不**发起。
- [ ] **Step 6: 三道门 + 提交**

```bash
git add packages/bot-core/schedule.js packages/bot-core/deck.js packages/bot-core/runner.js tests/botSchedule.test.js tests/botDeckCore.test.js tests/botRunner.test.js
git commit -m "feat(core): 可选 schedule 端口——quietHours 静默窗与刚上线静默窗（Q9/§12，浏览器默认不启用）"
```

---

### Task 3: core 全局小时闸 `globalHourlyMessages`（跨 bot，A2 的 min 语义就位）

**Files:**
- Modify: `packages/bot-core/schedule.js`（补 `createHourAccountor`）
- Modify: `packages/bot-core/deck.js`（计数来源 + `allowSpeak` 接入全局闸）
- Test: `tests/botSchedule.test.js`、`tests/botDeckCore.test.js`

**Interfaces:**
- Consumes: Task 2 的 `createGate(...)`、deck 现有 `handleEvent` 中 `type === 'activity' && payload.family === true` 分支
  - **⚠️ 原前提作废（裁定 R12）**：本节初稿写"家族消息 = 本 deck 真正发出去的一条，是全局计数的天然来源，不必新开端口"——**这句是错的**。`activity + family:true` 有**两个**发射点：`runner.js:330`（自家发送成功自报）与 `runner.js:230`（**收到**家族成员的帧；自家帧在 `:219` 被丢弃）。故 N 个**同房**运行 bot 时，一条真实发言 = 1 次自报 + (N−1) 次同胞回声 = **N 次 inc**，即 `globalHourlyMessages=120` 配 5 个同房 bot 实际只准 ~24 条/小时，且 `globalHourCount` 最高虚报 5×（§8.6 要求"status 数字与实际发出条数一致"）。误差因子恰为同房运行 bot 数（家族集只含运行中 deck-bot 的 nick，`deck.js:586-593`），人类/主人发言从不 inc，故非无界。方向偏省钱（fail-safe），但**计数与闸都失真**。
  - **修法（裁定 R12 定案）**：不新增事件类型，只给发送侧自报那一条加判别位 `sent: true`（`runner.js:330` 处）；deck 仅在 `family === true && payload.sent === true` 时 `inc()`。`family` 的调度器语义（max 语义保 idle 长窗）**保持逐字节不变**——判别位只用于计数，不参与调度决策。需改 `runner.js` 一行 + `deck.js` 一个条件，比"新增 'sent' 事件类型"更小，且不动 Task 1 钉住的"宿主汇只收 error/warn"契约。
  - 必须补测试把它钉住（审查 Minor #4 指出原实现只在注释里说明、无用例）：两个 fake runner，A 发 `{family:true, sent:true}`（自报）、B 发 `{family:true}`（收到 A 的话的回声）→ 断言 `globalHourCount === 1`。
  - **同轮附带（裁定 R14，破例把一条 Minor 拉进修复轮）**：`globalHourlyMessages` 传进来是负数/非有限/字符串时，deck 现在按"未配置"处理且**零告警**——与 Task 2 修复轮刚确立的"刹车装错了必须自己 announce"教义自相矛盾（畸形 `quietHours` 端点会 warn，畸形预算不会）。同一构造块、同一条理由、两行代码，拆到别处只会让代码带着已知不一致出厂。**注意 R12/R9 分工**：配置层（Task 4 validateConfig）拦字面量类型，core 层的 warn 是给 bot-core 直接消费者兜底，两者不互相替代。
- Produces: `createHourAccountor({ now, cap }) -> { inc(), count(), canSend(), settle() }`（整点自动归零，与 `rhythm` 的 `settleHour` 同语义但**跨 bot 单实例**）；`schedule.globalHourlyMessages?: number` 生效

- [ ] **Step 1: 写失败测试**

```js
it('两个 bot 共用一个全局闸：累计到 cap 后 allowSpeak(true) 也变 false（点名不发）')
it('家族 activity 每条 inc 一次；真人消息不 inc')
it('跨过整点后 count() 归零（注入 now 推进 3600_001ms）')
it('globalHourlyMessages 未配置 → 闸恒可发（浏览器零变化）')
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/botSchedule.test.js tests/botDeckCore.test.js` Expected: FAIL
- [ ] **Step 3: 实现** — accountor 只在 `schedule?.globalHourlyMessages` 存在时创建；`handleEvent` 的 family-activity 分支里 `inc()`；`gate.allowSpeak(mentions)` 的最终返回 = `!quiet非点名拦截 && 全局闸未填满`（Review Focus 第 5 行的合流顺序：点名可越过静默窗，但**越不过**全局闸）。
- [ ] **Step 4: 加合流测试** — 同一用例断言"静默窗内 + 全局满 → 点名也不发"，防两个闸的优先级被后续改动颠倒。
- [ ] **Step 5: 三道门 + 提交** — commit `feat(core): 跨 bot 全局小时闸（§12 成本刹车）`

---

### Task 3b: core — 每 bot 小时预算 `hourlyBudget` 真接通（插在 Task 7 之前执行）

**为什么多出这个任务（裁定 R24，控制器自造的计划缺陷）**：spec §8.1 的配置样例里有
`bots[].hourlyBudget`，Task 4 也照它建了白名单并做了类型校验（`config.js:51`、`:286-303`）。
但**没有任何东西消费它**：`runner.js:426` 只调 `createRhythm({ rng, now, chattiness })`，从不传
`params`；`deck.js` 的 `BOT_CFG_KEYS` 里也没有 `hourlyBudget`，所以 Task 7 把它交给 `addBot` 后会被
`normalizeCfg` **静默丢弃**。这正是我在 Task 3 审查轮里批评过的"存在但不生效的旋钮"（R14），
只不过这次是**我自己**造出来的。删除该键也可行，但那等于把 spec 样例里的一个能力抹掉且谎称实现；
接通它才诚实。`createRhythm` 本身**已经**支持 `params` 浅覆盖 `RHYTHM_DEFAULTS`
（`rhythm.js` 的 `params = {}` / `{...RHYTHM_DEFAULTS, ...params}`），所以本任务只做透传，不造新机制。

**Files:**
- Modify: `packages/bot-core/deck.js`（`BOT_CFG_KEYS` 增 `'hourlyBudget'`；`normalizeCfg` 保留它；
  `makeRunnerOpts` 透传）
- Modify: `packages/bot-core/runner.js`（`createRhythm` 调用处按存在与否传 `params: { hourlyCap }`）
- Modify: `packages/bot-daemon/config.js`（校验文案与注释指向"生效"，勿再声明未接线）
- Test: `tests/botDeckCore.test.js`、`tests/botRunner.test.js`、`packages/bot-daemon/tests/config.test.js`

**Interfaces:**
- Consumes: `createRhythm({ rng, now, chattiness, params? })`（`params` 浅覆盖，含 `hourlyCap`）；
  Task 2/3 的 gate/schedule（**每 bot 的 cap 与全局闸是两个独立层，都生效，谁先满谁拦**）
- Produces: bot 配置多一个可选字段 `hourlyBudget?: number`；`normalizeCfg` 语义：缺失或非有限值 →
  **不设该键**（不是 `null`、不是 0），因为 `runner` 要按"有没有"决定是否覆盖 `hourlyCap`。
  ⚠️ 注意 `pick()`（`deck.js:70-73`）会把 `undefined` 映射成 **null**（R17 已记），
  所以透传路径**不能**依赖 `pick` 保住了"省略"这个信息。

- [ ] **Step 1: 写失败测试** — ①`createRhythm` 收到 `params:{hourlyCap:20}` 当且仅当 bot 配了
  `hourlyBudget`；未配时 `params` 不含 `hourlyCap`（用 spy 断言入参形状，且**不得**多消耗 rng）；
  ②配了 20 的 bot 在第 21 条时被 `hourlyCap` 拦（沿用 rhythm 现有"超限只回 mentions"语义）；
  ③`persist` 往返：带 `hourlyBudget` 的 bot `load()` 后仍在，且**老载荷缺该键**时读回来是"未设"
  （不是 0——0 的含义是"一条都不发"，两者必须可区分）；④全局闸与 per-bot cap 同时在场的优先级用例。
  - **裁定 R25（Task 3b 审查轮对我这条 Step 1-① 的修正）**：①里"用 spy 断言 `createRhythm` 入参形状"
    **是我写计划时没验证过的可行性假设**——`runner.js` 静态 `import './rhythm.js'`，而 core 的
    `package.json` exports 只开 `"."`，走包名子路径 mock 不通（相对路径 `vi.mock` 那条路**未必**不通，
    审查者明说它没能证明，因为要写临时测试文件、且本仓零 `vi.mock` 先例）。
    实现体改用的替代方案经审查**逐Variant手工验证为等价甚至更强**：block 边界精确
    （第 N 条发、第 N+1 条挡）唯一确定 `hourlyCap ∈ {20,30,0}`，两种错参形状
    （`null`→从第 1 条就挡；`undefined`→31 条仍不挡）都会打红具体用例；
    deck 接缝断言用的是真生产端口 `deps.createRunner` 与真 `pick` 输出，不是 mock 记账。
    唯一未钉住的是"未配时 `params` 键缺席"这一**形状恒等**，而行为等价的写法
    （`hourlyCap: bot.hourlyBudget ?? 30`）无后果。**故本步以"行为三态 + deck 接缝快照"为准**；
    若将来确实要钉形状，去做相对路径 `vi.mock` 探针，别再假定包名子路径可行。
- [ ] **Step 2: 跑测试确认失败**（`npx vitest run tests/botRunner.test.js tests/botDeckCore.test.js`）
- [ ] **Step 3: 实现透传**（改动限于上述四处；不动 `RHYTHM_DEFAULTS` 的 30 默认值）
- [ ] **Step 4: 三道门全绿** — `npm test`（基线 488 只增）、`npm run build`、`npm run lint`；
  并**专门确认** schema 未 bump（可选字段是**加性**变更，`SCHEMA_VERSION` 保持 1）
- [ ] **Step 5: 提交** — `feat(core): 每 bot hourlyBudget 接通 rhythm hourlyCap（裁定 R24）`

### Task 4: daemon 包骨架 + ESM 配置 loader 与纯数据校验

**Files:**
- Create: `packages/bot-daemon/package.json`、`packages/bot-daemon/config.js`、`packages/bot-daemon/vitest.config.js`、`packages/bot-daemon/tests/config.test.js`
- Create: `packages/bot-daemon/bin/saigai-bot.js`（本任务只建占位入口，Task 9 填子命令）
- Modify: `package.json:12`（根 `test` 脚本追加 daemon 工程）、`vitest.config.js:10`（根 exclude 追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `loadConfig(path: string) -> Promise<Cfg>`：`import(path + '?t=' + now())`（§8.1 cache-buster）
  - `validateConfig(raw: unknown) -> { ok: boolean, errors: string[] }`，`Cfg = { name: string, serverUrl: string, provider: {baseUrl, apiKey?, model}, limits?: {globalHourlyMessages?, quietHours?{from,to}, startupQuietMs?}, ownerNick?: string, bots: Array<{id, name, persona, room, chattiness?, temperature?, hourlyBudget?, rawPrompt?}> }`
  - 校验红线：顶层必须是纯数据 default export；值允许 `process.env.X`；**函数 / symbol / 类实例 / 未知键 / `bots[].id` 重复或不合 `[a-z0-9-]{1,32}` / `room` 不合 `/^[a-z0-9]{6}$/` / `bots.length > MAX_BOTS`** → errors
  - **裁定 R15（订正本节初稿）**：初稿写"`room` 非 6 位 `[a-z0-9]` **或不在白名单公共房形态**"——后半句**作废**。daemon **无法**知道服务器的私房注册表（那是 `server/data/rooms.log` 服务端 append-only 落盘，多房间轮的设计），做白名单校验会把合法的**私房**一律判非法。故 `validateConfig` 只做**形状**校验 `/^[a-z0-9]{6}$/`；房间**是否存在**是运行时/服务器的事（配错会在 join 时拿 `join-error`，由 runner 分级处理与 `doctor` 的 WS 实测兜），不在静态校验里猜。
  - **`limits` 也必须校验**（Task 2 审查 ⚠️ 项补，裁定 R9）：`limits` 里的**未知键**一律拒（`quietHour` 少个 s 这种拼写错，若放过去会让 core 侧 `quietHours &&` 判空 → **静默失败为"永不静默"**，正是这道刹车要防的通宵烧钱）；`quietHours.from/to` 必须过 core 的 `parseClock`（复用同一份实现，不得另写正则）；`startupQuietMs` / `globalHourlyMessages` 必须是正数。理由：core 侧对畸形端点是 fail-**closed**（全天静默），对缺失键是 fail-**open**——两种失败方向相反，所以**必须在配置层就拦住**，不能指望下游兜。
  - `errors[]` 每条以字段路径开头（`bots[2].id: ...`），供 `doctor` 直接打印

- [ ] **Step 1: 建包与测试工程** — **建完 package.json 立刻在仓根跑 `npm install`**，并断言 `node_modules/kuoluosaigai-bot-core` 这个 workspace symlink 出现（裁定 R3：新 workspace 包不重装 → `Cannot find module`，会被误读成自己的代码写错）。`packages/bot-daemon/package.json`：`{ "name": "kuoluosaigai-bot-daemon", "type": "module", "version": "0.1.0", "private": true, "engines": { "node": ">=22" }, "bin": { "saigai-bot": "./bin/saigai-bot.js" }, "scripts": { "test": "vitest run" }, "dependencies": { "kuoluosaigai-bot-core": "*" } }`；`vitest.config.js` 内 `test: { environment: 'node', include: ['tests/**/*.test.js'] }`。
- [ ] **Step 2: 改根接线（这是"假绿"陷阱，必须同批改）** — 根 `test` 脚本尾部追加 `&& npm run test --workspace kuoluosaigai-bot-daemon`；根 `vitest.config.js` 的 `exclude` 追加 `'packages/bot-daemon/**'`。**理由**：根工程是 `environment: 'jsdom'`，不收这条就出现"同一套测试跑两遍"的双收集（今天在主检出实测过的 737/30 假失败正是这个形状）。
  **本步不要跑全量 `npm test`**（裁定 R2）：此刻 daemon 还没有测试文件，`vitest run` 会因
  "No test files found" 退非零 —— 那是**顺序**造成的空工程失败，不是回归。只跑
  `npm run test --workspace kuoluosaigai-bot-daemon` 之外的验证留到 Step 4（测试已存在）之后。
- [ ] **Step 3: 写失败测试**（`tests/config.test.js`）

```js
it('validateConfig：合法配置 ok=true，缺省字段回填（chattiness 50 / temperature 0.9）')
it('validateConfig：bots[].id 重复 → errors 含 "bots[1].id" 且指明 dup')
it('validateConfig：id 不合 [a-z0-9-]{1,32}（"李"、""、33 字符）→ 拒绝')
it('validateConfig：provider.apiKey 缺失但 process.env 未设 → 拒绝，错误文案不含 key 值')
it('validateConfig：room "SETSUBUN"（大写）→ 拒绝（服务器只认小写 6 位）')
it('serverUrl 缺省回填 `wss://kuoluosaigai.com`（§5）；显式 `ws://localhost:8080` 合法（本地联调）')
it('loadConfig 拒绝函数值：配置文件导出 { bots: () => [] } → errors 含 "必须是纯数据"')
```

> **裁定 R16（Task 4 审查轮暴露，是计划缺陷不是代码缺陷）**：上面第一条测试名把 `50 / 0.9`
> **写死成字面量**，而 core 从没导出这两个默认（`deck.js` 的 `normalizeCfg` 用
> `Number.isFinite(x) ? x : 50` 式参数兜底）。真实的分叉链：daemon 把 `chattiness: 50` 回填进 cfg →
> Task 7 传给 `addBot` → `deck.js` 见到**显式有限值**就不再套用自家默认 → 日后 core 默认若改成 60，
> 浏览器 bot 跑 60、daemon bot **静默跑 50**，正面撞 spec **G2**（拟人参数只有一份权威实现）与 **A8**，
> 形状与上一轮终审 **M4**（两个巧合等值的 15000）同型。
> **修法（定案）**：core 在 `deck.js` 导出 `DEFAULT_CHATTINESS` / `DEFAULT_TEMPERATURE`，
> `normalizeCfg` 自己改用它们（不再写字面量），`index.js` 一并导出；daemon 的 `config.js` **import**
> 这两个常量做回填，测试断言改为对照 import 进来的值——于是"缺省字段回填（50/0.9）"这条测试名
> **由构造保证为真**，不再靠注释同步。
> **别顺手过度合并**：`rhythm.js` 与 `llm.js` 各有一个同值参数默认，但是否属"bot 人格参数"这**同一个域**
> 需核实——本仓已有明确反例：`timing.js` 头注释专门写明服务端 `HEARTBEAT_MS=30000`（WS keepalive）
> 与客户端 `15000`（tick/心跳）是**两个域、不是重复**。同名同值 ≠ 同语义。
>
> **裁定 R17（Task 4 复审回校 R16 的措辞，以 R17 为准）**：复审查明 `rhythm.js:92`/`llm.js:86`
> 其实是**同域同值**（就是同一个 chattiness/temperature 参数），照 R16 字面读该合并——但**合并不了**：
> `deck.js` 已经 `import` 了 rhythm（`deck.js:43`）与 runner→llm（`deck.js:44`/`runner.js:40`），
> 让 rhythm/llm 反过来 import deck 的常量就是**循环依赖**；要合并必须新设一个"共享常量模块"，
> 那已越出本轮"零行为变化"的边界。故定案：**保留两处签名级默认 + 把理由写进代码注释**
> （已落在 `deck.js:51-56`），R16 那句"确认同域才合并"据此读作"**同域且无环才可合并**"。
> 二者在产品内所有 bot 路径上是**休眠**的（`addBot` 与载入都过 `normalizeCfg`，有限值必得；
> `runner.js:269/426` 无条件显式传参），唯一活路是外部消费者绕过 deck 直呼 `createRhythm`/
> `chatCompletion`——这正是注释所记的"边界兜底"角色。附带纠正一处 R16 未见的盲点：
> `deck.js` 的 `pick()`（`deck.js:70-73`）把 undefined 映射成 **null**，而 null **不会**触发 JS
> 参数默认值——任何未来依赖"省略即取默认"的改动都要走 `normalizeCfg`，不得靠 `pick` 传空。

- [ ] **Step 4: 跑测试确认失败** — Run: `npm run test --workspace kuoluosaigai-bot-daemon` Expected: FAIL
- [ ] **Step 5: 实现 `config.js`** — 纯数据判定用递归 `typeof` 扫描（函数/symbol/`__proto__` 键一律拒）；`MAX_BOTS` 从 core 再导出（`import { MAX_BOTS } from 'kuoluosaigai-bot-core'`），**不得**在 daemon 里抄第二份常量（R3 同族教训）。
- [ ] **Step 6: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): 包骨架 + ESM 配置 loader 与纯数据校验（Q1 单房/Q3 id 必填）`

---

### Task 5: `state.json` 存储适配器 —— apiKey 脱敏 + 孤儿身份保留（Q2/Q3）

**Files:**
- Create: `packages/bot-daemon/state.js`、`packages/bot-daemon/tests/state.test.js`
- Test: 同上

**Interfaces:**
- Consumes: `createDeck` 的 `storage` 端口形状 `{getItem, setItem, removeItem}`；core 的 `CONFIG_KEY = 'kuoluosaigai:bots:v1'`、`SCHEMA_VERSION`
- Produces: `createFileStateStore({ dir, fileName = 'state.json' }) -> { getItem(k), setItem(k, v), removeItem(k), readOrphans(), path }`
  - 只服务 `CONFIG_KEY`，其它键 → `getItem` 返回 `null`、`setItem` 忽略（daemon 侧没有第二个 deck 键）
  - **写盘前剥 key**：`providers[].apiKey` 一律删；文件形状 `{version, providers:[{id,name,baseUrl}], bots:[{id,nick}], lifetime:{}, orphans:{}}`
  - **孤儿保留**：与上一次写入比较，消失的 botId 把 `{nick, lifetime}` 存进 `orphans[id]`；`loadInto` 不读 `orphans`（core 只认 `providers/bots/lifetime`，多出来的键被忽略），由 `readOrphans()` 供 Task 7 复用

- [ ] **Step 1: 写失败测试**

```js
it('setItem 落盘后，文件文本中搜不到 apiKey 明文（Review Focus #2）')
it('落盘形状：providers 只剩 {id,name,baseUrl}；bots 只剩 {id,nick}')
it('botId 从新 payload 消失 → orphans[id] 保 nick 与 lifetime')
it('getItem 读坏 JSON → 返回 null（交给 deck 的 B15 重建），不抛')
it('原子写：写盘用 tmp+rename，中途异常不留半个文件')
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm run test --workspace kuoluosaigai-bot-daemon` Expected: FAIL
- [ ] **Step 3: 实现** — 写：`writeFileSync(tmp)` → `renameSync(tmp, final)`；读：`readFileSync` + `JSON.parse` try/catch。`setItem` 收到的字符串**必然**含 apiKey（已核 `deck.js:496` 写 `pick(p, PROVIDER_KEYS)`），所以剥 key 只能发生在本适配器，别指望改 core。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): state.json 旁挂存储——apiKey 落盘前剥离 + 孤儿身份保留（Q2）`

---

### Task 6: 进程级单实例锁（A5 / §7.4）

**Files:**
- Create: `packages/bot-daemon/lock.js`、`packages/bot-daemon/tests/lock.test.js`

**Interfaces:**
- Consumes: `node:fs` 的 `openSync(path, 'wx')`（O_EXCL）、`process.kill` 探测
- Produces: `acquireLock({ dir, fileName = 'saigai-bot.lock', pid = process.pid, startedAt = Date.now(), isAlive = (p) => boolean }) -> { ok: true, tookOver: boolean, writeLock() } | { ok: false, holder: {pid, startedAt} }`；锁文件内容 `{pid, startedAt}` JSON；`releaseLock()` 只删自己的锁
  - **裁定 R21（本条初稿与控制器派发令相冲突，以实现为准）**：初稿把锁写成
    `{ ok, tookOver, writeLock() } + 独立的 releaseLock()`，而派发令给的是**句柄式**
    `{ ok: true, tookOver, release() }`。两者不一致时**以派发令/实现为准**（`lock.js:100,145`）：
    锁的归属信息（pid/startedAt）本来就在句柄里，`release()` 自带对账，没有"模块级全局锁状态"
    需要暴露；`writeLock()` 更是被 O_EXCL 创建取代（见 §7.4 与本任务实现），留着只会误导。
    **Task 9 的 `run` 序列请按 `lockHandle = acquireLock(...)` / `lockHandle.release()` 写**，
    不要再去补一个 `releaseLock()`。
  - **连带事实（Task 9 必须处理）**：抢锁有 `MAX_ATTEMPTS = 8` 的竞态重试上限；耗尽时返回的
    `holder` 可能是 `{ pid: null, startedAt: null }`（实现里标注为"正常路径不可达"）。
    `run` 在 `ok:false` 分支**不得**无条件打印 `holder.pid`（会打出 `null` 让运维一头雾水），
    要分"知道是谁"与"不知道是谁"两种文案，且两者都**必须非零退出、绝不静默**（A5）。

- [ ] **Step 1: 写失败测试**

```js
it('无锁 → ok:true, tookOver:false，并写出含 pid/startedAt 的文件')
it('锁存在且 PID 存活 → ok:false，holder 报出对方 pid（绝不双跑，A5）')
it('锁存在但 PID 已死 → ok:true, tookOver:true（调用方负责打 WARN）')
it('锁文件内容是坏 JSON → 视为陈旧锁接管，不因脏文件永挂')
it('releaseLock 由非持有者调用 → 不删他人锁')
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现** — `isAlive` 必须是注入参数（测试用假 PID）；默认实现 `process.kill(p, 0)` 且区分 `ESRCH`（死）与 `EPERM`（活但无权限 → 判活，保守）。接管时不改写旧内容再写，而是 `unlink` → 重新 O_EXCL，防两个接管者互相覆盖。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): 单实例锁（O_EXCL + PID 陈旧判定与接管）`

---

### Task 7: daemon 宿主组装 —— 配置→deck 调和、diff 与启停

**Files:**
- Create: `packages/bot-daemon/host.js`、`packages/bot-daemon/converge.js`、`packages/bot-daemon/tests/host.test.js`、`packages/bot-daemon/tests/converge.test.js`

**Interfaces:**
- Consumes: `createDeck({ storage: fileStateStore, lease: createNullLease(), reactiveImpl: (o) => o, getOwnerNick, wsUrl, now, deps: { WebSocketImpl, sleep, onEvent } })`；`deck.addProvider/addBot/startBot/stopBot/removeBot/switchBotRoom/updateBot/dispose`；Task 5 的 `readOrphans()`；Task 2/3 的 `schedule`
- Produces:
  - `diffConfigs(prev: Cfg, next: Cfg) -> { added: [], removed: [], changed: [], unchanged: [], limitsChanged: boolean, serverUrlChanged: boolean, providerChanged: boolean }`（纯函数，按 `id` 寻址；`changed` = 除 `id` 外任一字段变；顺序变化不算变更）
  - **裁定 R27（Task 7 审查暴露的两处计划盲点，属本任务范围）**：
    ①**`serverUrl` 必须进 diff**。本任务初稿只比 bots 与 limits，而 `wsUrl` 在 boot 时被冻进 deck 闭包
    （`host.js:182`、core 侧 `makeRunnerOpts` 读闭包），converge 既不看也不报，加上
    `current = nextCfg` 会让这次改动**对之后每一次 diff 都永久隐形**；而 Task 8 被规定
    "业务动作一律交给 `host.converge`"——于是**整条链上没有任何一层能把它报出来**：
    操作者把 daemon 指到另一台服务器，看到的是一次"成功热重载"，bot 却仍连在旧服务器上。
    这正是实现体自己用来论证 limits 兜底合理的那条标准（"静默忽略违反 R11 精神"），
    不能只对 limits 适用、对 serverUrl 失灵。修法：`converge` 内比 `current.serverUrl !== next.serverUrl`，
    折进 `restartRequired` 与 warn（与 limits 同类：都需要**进程重启**，不是 bot 重启）。
    ②**`provider.model` 变化要扇出到全部存活 bot**。`model` 在 core 里是 **bot** 字段
    （`BOT_CFG_KEYS`），runner 从 bot 快照取（`runner.js:269`），而 `updateProvider` 只写
    name/baseUrl/apiKey。只给 `diff.changed` 补 `model` 的话，**未变更 bot 的旧 model 会在进程内
    一直陈旧**——连手动 stop/start 都还是旧值（boot 期的对齐才修得回来），而现有 warn 文案
    却宣称"新 apiKey/baseUrl/model 已写入 deck"。修法：`providerChanged` 且 model 有变时，
    把新 model 用 `updateBot` 打到**所有存活 bot**（changed ∪ unchanged；`updateBot` 不碰 runner，
    因此不违反 A4），并把 warn 文案改准。
  - **R27 附带捆绑（破例第二条，理由记档）**：Minor「热移除会丢 ≤10s 的 token 账」
    （孤儿折叠取的是**上次落盘**的基准，而 deck 对 lifetime 有 10s 节流，`removeBot` 又先删
    `store.lifetime[id]` 才 persist）与 Minor「pending 重启状态没有持久面」
    （`snapshot()` 是 Task 10 唯一的宿主读数口，却没有粘滞的 `restartRequired`）——
    前者直接吃 Q2 承诺的"账目"，后者是我 R26 那句"不可能看漏"的**完成条件本身**，
    且都是**一行级**修改（removal 循环里 `deck.persist()` 先于 `stopBot`；`meta.restartRequired`
    置位后只由进程重启清除）。把它们拆到终审等于让 Task 8-10 建在一个说谎的 Report 契约上。
    仍**不**捆绑的：R20 rt 优先级缺 runner 侧用例、MAX_BOTS 拒绝项误报 `added`、
    unchanged/buffer 只有聚合断言 → 全部 parked。
  - `createDaemonHost({ cfg, store, logger, now, WebSocketImpl, sleep }) -> { boot(): Promise<void>, converge(nextCfg): Promise<Report>, snapshot(): object, shutdown(): void }`（`converge` 内部调 `diffConfigs` 得动作集，再由本任务决定每类动作怎么落地）
  - `boot()`：`deck.load()` → 按 `cfg.bots[].id` 建/更新 provider 与 bot（`addBot` 传**显式 id**，Q3）→ 逐个 `startBot(id)`；`orphans` 里同名 id 的 `nick` 经 `updateBot(id, {nick})` 复用（身份跨重启延续）
  - **裁定 R19（Task 5 审查 ⚠️ 项归位）**：Q2 明文"保留 state 条目但**打 ORPHAN 日志**（防误删配置即丢身份）"。
    Task 5 的 `state.js` **不持有 logger**（它的职责是边界失效，不是播报），故这条日志**归本任务**——
    `createDaemonHost` 已收 `logger`。落点两处：①`boot()` 复用孤儿身份时打一条 `info`（含 id 与复用的 nick）；
    ②`converge()` 删除 bot 时打一条 **`warn` 级 ORPHAN**（含 id 与"身份与账目已保留在 state，重新写回同名 id 即复用"）。
    缺了②就等于 Q2 的保护只剩一半：数据留下了，但操作者**看不见**它留下了。
    另记 Task 5 审查的连带事实：`computeOrphans` 从缓存基准重播，所以**手工删 `state.json` 里的孤儿条目不会生效**
    （下一次写就复活）——若 Task 10 的 `status` 要暴露孤儿，须一并给出一条清理途径。
  - provider 的 `apiKey` 只在这一步从 `cfg.provider.apiKey ?? process.env` 注入 deck，**永不**回写盘（Task 5 已保证）
  - `snapshot()`：每个 bot 的 `{id, name, room, status, nick, hourCount, session, lifetime}` + `meta:{name, uptimeMs, globalHourCount, restartRequired, generatedAt}`（Task 10 的 `status` 与 P3 的 dev-state 帧都吃它；`deviceId` 属 P3，不在 P1 产出）
    - **裁定 R28（复审校正 + 给 Task 8 的歧义警告）**：①上面这条摘要行原本还留着已作废的
      `deviceId` 且漏了 `generatedAt`/`restartRequired`，按实现改齐；②**`restartRequired` 现在有两个
      同名字但不同语义**——`report.restartRequired` 是**本次 converge** 的，`meta.restartRequired` 是
      **粘滞**的（一旦置位只由进程重启清除）。Task 8 的 watcher 读的是 Report，Task 10 的 status 读的
      是 snapshot；**别把粘滞位当成"当前仍待重启"的唯一真相源去反向推断**，也别在 watcher 里
      用 `meta` 做收敛判断。

- [ ] **Step 1: 写失败测试**（`tests/host.test.js`，注入假 runner/scheduler：`deps.createRunner` 走现成替身，真 WS 不连）

```js
it('boot 后 deck.bots 的 id 集合 === cfg.bots 的 id 集合（显式 id，不是 bot-0 自造号）')
it('ownerNick 生效：getOwnerNick() 返回配置里的 ANON 昵称（Q11）')
it('孤儿复用：state 里 orphans["lixiao"].nick="ANON-7C2D"，配置重新出现同 id → 复用该 nick')
it('converge 删除 bot：deck 里移除、runner.stop 被调、state 里进 orphans（不误删身份，Q2）')
it('converge 改名（name 变、id 不变）→ 走 updateBot，**不** stop/start（A4：不许掉线）')
it('snapshot 不含 apiKey 任何子串')
```
同任务再加 `tests/converge.test.js`（纯 diff，先于接线测）：

```js
it('新增/删除/改名/改 room 各归其类；全部 unchanged 时四个数组皆空')
it('数组顺序变化不视为变更（按 id 集合与字段比较，不是位置，Q3）')
it('limits 变化 → limitsChanged:true（不重启 bot，只重算闸）')
it('bots: [] vs 三个 bot → removed 三项（用户真想全停，与畸形读盘的区别由 watcher 侧负责，Task 8）')
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现 host.js** — 关键顺序：先 `deck.load()` 再调和，否则 Task 5 的 `orphans` 读不到。`schedule` 从 `cfg.limits` 映射（`quietHours`/`globalHourlyMessages`/`startupQuietMs`），未配置就**不传**（Task 2 的"缺省零变化"承诺在 daemon 侧也要能被单测证明传了）。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): 配置↔deck 调和宿主（显式 id/孤儿复用/改名不断线）`

---

### Task 8: 配置热重载 watcher —— 轮询 + debounce + 坏读不动作（G3/Q10/A4）

**Files:**
- Create: `packages/bot-daemon/watch.js`、`packages/bot-daemon/tests/watch.test.js`

（watcher 的**接线**在 Task 9 的 `run` 启动序列里做——本任务只交付独立可测的 watcher，不去改尚未存在的 `cli.js`。）

**Interfaces:**
- Consumes: Task 4 `loadConfig/validateConfig`、Task 7 `host.converge(nextCfg)` 与 `diffConfigs`
- Produces:
  - `createConfigWatcher({ load: () => Promise<raw>, intervalMs = 1000, debounceMs = 500, onSettle }) -> { start(), stop() }`：**默认轮询**（`fs.watch` 在 NAS/SMB 挂载下可能失灵，§14；`--watch=fswatch` 切换属 builder 自由，不在本任务）
  - 稳定判据由 watcher 负责（内容指纹连续相同 + 读取不抛），**业务动作一律交给 `host.converge`**，watcher 内不出现 addBot/startBot

- [ ] **Step 1: 写失败测试**（`watch.test.js`，注入假定时器与假 `load`）

```js
it('抖动合并：连续 3 次读到不同中间态，只在最后一次稳定 500ms 后 onSettle 一次（debounce）')
it('load 抛异常（半写文件/语法错误）→ **不**回调 onSettle，保留上一份好配置（Review Focus #4）')
it('解析成功但 bots: [] → 视为**合法**空集合，回调（用户真想全停）与畸形读盘要能区分')
it('检测后 ≤2s 完成收敛：从最后一次 mtime 变化到 onSettle 被消费的注入时钟差 ≤2000ms（Q10 口径）')
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm run test --workspace kuoluosaigai-bot-daemon` Expected: FAIL
- [ ] **Step 3: 实现** — watcher 只认"读到的内容指纹变了"（`JSON.stringify` 指纹或 mtime+size 二选一，别引 chokidar）；"畸形读盘"与"合法空集合"的区分靠**异常 vs 成功解析**，不靠内容长度。收敛动作一律交给回调里的 `host.converge`。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): 配置热重载 watcher——轮询 1s + debounce 500ms + 坏读保旧配置（G3/Q10/A4）`

---

### Task 9: CLI `run` / `validate` / `doctor`（含 §5 那条未实测前提）

**Files:**
- Create: `packages/bot-daemon/cli.js`、`packages/bot-daemon/doctor.js`、`packages/bot-daemon/bin/saigai-bot.js`（填实）、`packages/bot-daemon/tests/cli.test.js`、`packages/bot-daemon/tests/doctor.test.js`

**Interfaces:**
- Consumes: Task 4 loader、Task 5 store、Task 6 lock、Task 7 host、Task 8 watcher；core 的 `chatCompletion`、`createBotConnection`
- Produces: `main(argv: string[]) -> Promise<number>`（**退出码返回，不在 bin 里顶层 await**）
  - `saigai-bot run [--config <p>] [--data-dir <d>] [--once]`
  - `saigai-bot validate <file>`（不连网）
  - `saigai-bot doctor [--config <p>]` → 逐项检查并打印 `OK/FAIL`：Node 版本 ≥22、原生 `globalThis.WebSocket` 存在、配置纯数据校验、**provider 连通性实测**（对 `baseUrl` 发一次最小 chat 请求）、**serverUrl WS 可达实测**、本地时钟偏移、数据目录可写
- [ ] **Step 1: 写失败测试**（`doctor.test.js`，注入假 `fetchImpl`/`WebSocketImpl`）

```js
it('provider 401 → 该项 FAIL 且 detail 不含 key（B9 同源）')
it('provider 429 → FAIL 但文案区分于 auth（运维要能分辨"没配额"与"key 错"）')
it('WebSocket 不可达 → FAIL 且给出 serverUrl，不谎报 OK')
it('全部通过 → 退出码 0；任一 FAIL → 退出码 1')
```

- [ ] **Step 2: 写失败测试**（`cli.test.js`）：`--once` 起一轮即退（CI 用）、`validate` 非法配置退出码 1 且 stdout 列出 `errors`、未知子命令打印用法并退 2。
- [ ] **Step 3: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 4: 实现 run 的启动序列** — 顺序钉死：解析参数 → `loadConfig` → `validateConfig`（拒则退 1）→ `acquireLock`（失败则打印 holder pid 并退 3，**不静默退出**，A5）→ `tookOver` 时打 WARN → `createFileStateStore` → `createDaemonHost` → `boot()` → 起 watcher →（`--once` 则立即收敛退出）。`SIGTERM/SIGINT` → `shutdown()` = watcher.stop → `host.shutdown()` → `releaseLock()`。
- [ ] **Step 5: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): CLI run/validate/doctor——含 VPS 出网与 WS 可达实测（§5 未验前提）`

---

### Task 10: 本地控制面 —— `rpc.json` + `127.0.0.1` 控制服务 + `status`（Q12）

**Files:**
- Create: `packages/bot-daemon/rpc.js`、`packages/bot-daemon/tests/rpc.test.js`
- Modify: `packages/bot-daemon/cli.js`（加 `status` 子命令）、`packages/bot-daemon/tests/cli.test.js`

**Interfaces:**
- Consumes: Task 7 `host.snapshot()`、Task 1 的 `logger`/`onEvent`
- Produces:
  - `startControlServer({ snapshot, dir, host = '127.0.0.1', secret = randomHex(16), readBodyLimit }) -> { port, close() }`，落 `rpc.json` = `{port, secret, pid, startedAt}`，`fs.chmodSync(path, 0o600)`（**Windows 下 chmod 是尽力而为**：绑定回环 + secret 才是真防线，文档要写明）
  - `GET /status` → 200 `snapshot()` JSON；缺/错 `X-Saigai-Secret` → 401；路径非 `/status` → 404（A3：不给任意 URL/指令）
  - `saigai-bot status [--data-dir <d>]` → 读 `rpc.json` → 带 secret 请求 → 人类可读表格；读不到 → 明确报"daemon 未在运行"

- [ ] **Step 1: 写失败测试**

```js
it('无 secret → 401；错 secret → 401（同一响应体，不给枚举 oracle，A7 精神）')
it('/status 返回体里搜不到 apiKey 明文（Review Focus #2 的控制面侧）')
it('未知路径 → 404，且不调用 snapshot')
it('请求体大小上限生效：超大 body 被拒（防控制口被当放大器）')
it('close() 后 rpc.json 被删除（不留指向死端口的陈旧文件）')
it('status 口径：快照附 generatedAt，CLI 显示"数据为 N 秒前"（Q12 ≤5s 旧）')
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现** — 只用 `node:http`；server 端口传 0 让内核分配，再把实际端口写进 `rpc.json`。`snapshot` 每次实时取（≤5s 旧的说法来自进程内周期快照，本任务先直取，P3 再按需加缓存）。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(daemon): 本地控制面 rpc.json + 回环 status 服务（Q12）`

---

### Task 11: 结构化 stdout 日志 —— 消费 `onEvent` 且全程 redact（§8.2）

**Files:**
- Create: `packages/bot-daemon/log.js`、`packages/bot-daemon/tests/log.test.js`
- Modify: `packages/bot-daemon/host.js`（把 `deps.onEvent` 接到 logger）、`packages/bot-daemon/tests/host.test.js`

**Interfaces:**
- Consumes: Task 1 的 `deps.onEvent(type, {botId, ...})`（`error`/`warn`）
- Produces: `createLogger({ write = (s) => process.stdout.write(s), now, redact }) -> { info(obj), warn(obj), error(obj), event(type, payload) }` —— 一行一条 JSON（journald 友好），字段固定 `{ts, level, botId?, kind?, msg}`；`run` 里 `createDaemonHost({logger})` 用它

- [ ] **Step 1: 写失败测试**

```js
it('provider apiKey 出现在被记录的对象里 → 输出中只剩后 4 位（"sk-****xxxx"）')
it('多把 key 同时注入 → 全部被遮（不许只遮第一条）')
it('rate 事件 → level=warn；auth 事件 → level=error（§8.2 的 429 风暴/密钥退化信号）')
it('日志一行一条合法 JSON，且不含 "Authorization"')
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现** — `redact` 用"值匹配 + 键名匹配"双策略：键名含 `key`/`token`/`secret` 一律遮；另把已知 key 的**值**注册进集合做全文替换（防止 key 出现在 `message` 自由文本里漏网）。后四位取法 `slice(-4)`，不取前缀。
- [ ] **Step 4: 三道门 + 提交** — commit `feat(daemon): 结构化 stdout 日志 + apiKey 双策略脱敏（§8.2/A3）`

---

### Task 12: systemd unit 与运行语义文档（§8.4/§8.5）

**Files:**
- Create: `packages/bot-daemon/deploy/saigai-bot.service`、`packages/bot-daemon/deploy/README.md`、`packages/bot-daemon/tests/deploy.test.js`
- Modify: `packages/bot-daemon/package.json`（`files` 字段含 `deploy/`，防 npm 发包漏 unit）

**Interfaces:**
- Consumes: Task 9 CLI 入口
- Produces: 无新接口（配置/文档产物）

- [ ] **Step 1: 写 unit** — `Restart=always`、`RestartSec=5`、`After=network-online.target`、`MemoryMax=192M`、`DynamicUser=yes`、`ProtectSystem=strict` + `ReadWritePaths=` 指向数据目录；`ExecStart=/usr/bin/env saigai-bot run`。
- [ ] **Step 2: 写 README 的三条"不是 bug"语义**（§8.4，不写清会被当故障报）：① 会话缓冲纯内存、重启即清、靠 P2P 历史重建；② 小时计数不跨重启持久（重启可能多烧一点）；③ 删除配置里的 bot 后 `state.json` 仍保留其 `nick`/账目于 `orphans`，同名 id 回来即复用（防误删丢身份）。另写 `rpc.json` 权限说明（Windows chmod 尽力而为）。
- [ ] **Step 3: 校验 unit 语法** — `systemd-analyze verify` 本机大概率没有 systemd：改为在 README 里留命令给用户在 VM 上跑，并把 unit 的缩进/键名用一条**文本测试**钉住（`packages/bot-daemon/tests/deploy.test.js`：断言含 `ProtectSystem=strict`、`DynamicUser=yes`、`Restart=always` 三行）。
- [ ] **Step 4: 三道门 + 提交** — commit `docs(daemon): systemd unit 与常驻运行语义（§8.4/§8.5）`

---

### Task 13: 浏览器侧「导出为 `saigai-bot.config.js`」按钮（用户 2026-11-03 裁定，§8.1.1）

**Files:**
- Create: `src/bots/export.js`、`tests/botExport.test.js`
- Modify: `src/components/BotDeck.vue`（面板底部按钮）、`tests/BotDeck.test.js`

**Interfaces:**
- Consumes: `store`（`providers`/`bots`）、Task 4 的 `Cfg` 形状（**只作为注释引用，不 import daemon 代码**——`src/` 不得依赖 daemon 包，方向只能反过来）
- Produces: `buildConfigFile({ providers, bots, deviceName }) -> string`，产出合法 ESM 纯数据 default export；`apiKey` 一律写成 `process.env.KUO_LLM_KEY` 占位，**绝不**内联明文
- **裁定 R18（Task 4 复审带来的两条 T13 约束，属本任务范围）**：
  1. **导出物必须从 `raw`（用户真正设过的字段）生成，不得从回填后的 `cfg` 生成。** `validateConfig`
     会把 `chattiness`/`temperature` 等缺省**补成显式值**（`config.js:302` 每条 bot 都带全这两个键）。
     若导出时照抄这份回填结果，就等于把"当时代码里的默认值"钉进用户手写的配置文件，
     **日后 core 改默认对这个用户永久失效**——正是 R16/R17 刚消灭的那类分叉，换个途径复活。
     断言方式：给一个**省略** `chattiness` 的 bot，导出文本里**不该**出现 `chattiness:`。
  2. **顺手把 `src/components/BotDeck.vue:134/137` 的 `chattiness: 50` / `temperature: 0.9`
     字面量换成从 core import `DEFAULT_CHATTINESS` / `DEFAULT_TEMPERATURE`**（该文件已经在 import
     `MAX_BOTS`/`PROVIDER_PRESETS`，改动近乎免费）。这是同一 bug 类在**浏览器侧**的活体实例：
     表单初始值会作为显式值流进 `addBot`，core 默认日后改动传不到 UI 新建的 bot。
     另记一处待清雷：`src/components/BotCard.vue:107` 的 `temperature: 0.7` 是**死数据**
     （`toggleEdit` 在表单渲染前会用真值重刷 `draft`），但它恰好就是新常量注释里引的"终审 M1 曾误 0.7"
     那个值——任何将来"不走 `toggleEdit` 直接渲染 `draft`"的编辑态重构都会被它误导。本任务若不改它，
     至少在 ledger/PR 说明里点名。

- [ ] **Step 1: 写失败测试**

```js
it('导出的字符串里不含任何 apiKey 明文，含 "process.env.KUO_LLM_KEY"')
it('导出物与计划"共享 fixture"那段**同形**（用 new Function 解析比对字段集合；不得 import daemon 的 config.js，裁定 R6）')
it('多 provider → 取 bot 实际引用的那个；未引用的 provider 不进导出物')
it('persona 含反引号/${} 的文案 → 转义安全，不破坏模板字符串')
it('bots[].id 缺失（浏览器自造 bot-0）→ 导出时补一个合 [a-z0-9-]{1,32} 的稳定 slug')
```
（第 2 条在 jsdom 测试里用 `new Function` 解析返回值即可，真 `import()` 往返放 daemon 侧 Task 4 的用例里成对钉。）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/botExport.test.js` Expected: FAIL
- [ ] **Step 3: 实现 + 接线** — `BotDeck.vue` 加按钮，点击 → `Blob` + `URL.createObjectURL` + `a.download`，全程本地、不发任何请求（§8.1.1 硬约束）。
- [ ] **Step 4: 跑测试确认通过 + 三道门 + 提交** — commit `feat(bots): 浏览器 deck 导出 saigai-bot.config.js（本地生成，key 走 env 占位）`

---

## P1 交付判据（spec §8.6，最后一项是人类动作）

自动化能覆盖的部分到 Task 13 为止。§8.6 的验收里这几条**必须在你那台 PVE VM 上真跑**，本环境给不出证据：

- 连续跑 24h：bot 数固定时无内存增长
- 无人时不出现秒回/连发风暴（`quietHours` + 全局闸 + 上线静默窗真的生效）
- `status` 数字与实际发出条数一致（≤5s 旧快照口径，Q12）
- 改一个 bot 的 persona 后**其余 bot 连接未断**（A4，用 `server/` 侧日志或 `status` 的连接建立事件验）
- `doctor` 对"VPS 出网能否稳定连 DeepSeek/Kimi/OpenRouter"给出**明确结论**（§5/§16 那条未实测前提；不通则宿主 bot 只能锁可达服务商）
- **夜间静默窗内连接没被踢掉**：`server/index.js:58` 已有 30s 服务端 keepalive ping、客户端自动 pong，所以 CF Tunnel 的空闲超时风险（§16 未决项）理论上由现成机制兜住；但 24h 静默窗是第一次真跑它——`status` 里连接建立事件若出现非人为的重连风暴，回来报，这是 core 侧的问题不是壳的问题

`saigai-bot pair` / `revoke` **不在本计划**（属 P3，§8.2 明确 P1 阶段先不出现，避免文档承诺未实现能力）。
