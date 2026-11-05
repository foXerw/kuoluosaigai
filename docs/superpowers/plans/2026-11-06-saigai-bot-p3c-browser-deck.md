# P3c 浏览器远端 Deck 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BOT DECK 增加「本浏览器 | 已配对设备」切换：手机/另一台电脑配对 daemon、看在线状态与 bot 运行态、改 persona/房间/启停/增删 bot、列出并撤销配对会话；API key 只显示 keyHint。

**Architecture:** 新增 `src/bots/remote.js`（宿主无关的远端 store：配对/连接/状态/命令，注入 WebSocket/storage/reactiveImpl）与 `RemoteDeck.vue`（复用 BotCard 的展示与操作）；`BotHub.vue` 在本地 BotDeck 与远端 deck 间切换，App 渲染 BotHub。daemon 的 `dev-state` 增加非敏感配置字段供远端编辑。

**Tech Stack:** Vue 3、现有 BotCard、浏览器 WebSocket、vitest + @vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §11.5 / §11.9

## Global Constraints

- **Q5(a)**：浏览器只能显示 `keyHint`，绝不能编辑/读取完整 apiKey；远端 store 不存 key。
- 浏览器凭证是配对返回的 **session token**（不是 daemon 设备令牌）；存 localStorage `kuoluosaigai:devices:v1`，不显示、不打印。
- 远端编辑是运行时修改（daemon 重启回配置）；房间切换由 daemon R20 持久化。UI 必须如实说明。
- 复用 BotCard：展示/操作走同一组件；远端状态映射成 BotCard 期望的 `{id,name,roomId,rt}` 形状。
- 质量门：前端/daemon 测试、`npm test`、`npm run build`、`npm run lint` 全绿。

## Review Focus

1. **凭证泄漏**：session token 出现在 DOM/日志/错误文案；keyHint 之外的 key 材料进入远端 store。
2. **远端命令错路由**：命令未带 `to` 或发到错误设备；未连接时按钮仍发命令；待回执 id 串台。
3. **离线/撤销状态**：daemon 离线仍显示在线；session 被撤销后仍可操作；设备从 roster 删除后仍自动重连。
4. **R20/运行时语义误导**：UI 让用户以为远端人格修改会跨重启保留。
5. **XSS/注入**：设备名、bot 名、label 原样渲染到 DOM。

---

### Task 1: daemon `dev-state` 补配置字段（仍无 key）

**Files:** Modify `packages/bot-daemon/commands.js`、`host.js`；tests。

- [ ] 测试：`buildDevState` 带 configBots 时含 persona/chattiness/temperature/model/providerId；仍不含 apiKey。
- [ ] 实现：`buildDevState({snapshot, provider, configBots})` 按 id 合并；host `pushState` 传 `current.bots`。
- [ ] 测试绿；提交 `feat(daemon): dev-state 补远端编辑所需配置字段（P3c）`。

### Task 2: 远端 store `src/bots/remote.js`

**Files:** Create `src/bots/remote.js`、`tests/remoteStore.test.js`。

**Interfaces:** `createRemoteStore({wsUrl, storage, WebSocketImpl, reactiveImpl, now, rng?})` → reactive `{devices, selectedId, status, online, bots, providers, sessions, notice, selectedDevice, pair(code,label), connect(id), disconnect(), command(cmd,args), refreshSessions(), revokeSession(id), removeDevice(id)}`；localStorage roster `[{deviceId,name,token,sessionId}]`。

- [ ] 测试：pair-claim 存 roster；auth 帧含 deviceId/sessionId/token；dev-state 映射 bots/providers；command→dev-cmd→dev-res resolve/reject；offline/online；dev-revoked 清设备；refresh/revoke sessions；未连接命令拒绝；roster 持久化。
- [ ] 实现；测试绿；提交 `feat(bots): 远端设备 store 与命令通道（P3c）`。

### Task 3: UI 切换与远端面板

**Files:** Create `src/components/BotHub.vue`、`src/components/RemoteDeck.vue`；Modify `src/App.vue`；tests。

- [ ] 测试：BotHub 默认本机 deck、切到已配对设备显示 RemoteDeck、关闭；RemoteDeck 配对表单、设备选择、在线/离线、bots 列表复用 BotCard、keyHint 展示且无 key 输入、sessions 撤销、运行时修改提示。
- [ ] 实现；测试绿；提交 `feat(bots): BOT DECK 本机/远端切换与配对面板（P3c）`。

### Task 4: 文档、门、独立审查

- [ ] spec §11.10 P3c 状态；README/deploy 文档配对手机步骤（面板）。
- [ ] `npm test` / build / lint；opus 审查 + 修复。
- [ ] 提交 `docs(bots): P3c 远端 deck 与配对说明`。

## Self-Review 备注

- 远端面板不提供 API key 编辑（Q5a）；新增 bot 会提示需要在 daemon 本机配置 key。
- 远端观战缓冲不提供（dev-state 不含消息内容）；BotCard 的 watch 区在远端模式下隐藏。
- 房间/人格修改的持久化语义与 P3b 一致：房间持久化，其余运行时。
