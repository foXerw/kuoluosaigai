# P3b daemon 设备客户端与配对 CLI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon 侧接上 P3a 的设备通道：本地设备令牌、`/device` 客户端、`pair`/`revoke --all`、命令白名单与 R20 房间持久化。

**Architecture:** 新增五个纯 Node 模块（`device.js` 令牌身份、`runtime.js` 房间覆盖、`relay-client.js` WS 客户端、`commands.js` 白名单、`rpc` 扩展），宿主 `host.js` 组装；CLI 只经本地回环 rpc 触发配对/撤销。daemon 仍**不写配置文件**；远程人格/增删 bot 是运行时修改（重启回配置），房间切换按 R20 写 `runtime.json`。

**Tech Stack:** Node 22 内建、`ws`（已有）、vitest。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §11 / §11.8 / R20

## Global Constraints

- **Q5(a)**：API key 永不进中继。daemon 命令层拒绝任何 `apiKey` 字段（深度 scan fail-closed）；`dev-state` 只带 `keyHint`（`****后4位`）。
- 设备令牌 64 hex，`deviceId = sha256(token)[:16]`；`device.json` 只存 token、原子写、0600 尽力而为；令牌不出日志。
- **R20**：`bot.switchRoom` 持久化到 `runtime.json`（记录 `{room, baseRoom}`），启动/热重载时只在配置房未变时应用覆盖；配置改了房 → 清覆盖、配置赢。快照报有效房。
- 远程 `bot.add/update/remove` 是**运行时**修改：不写配置，重启后以配置为准；面板文案必须如实说明。
- daemon 绝不把完整 apiKey 放进 `dev-state`/`dev-res`/日志；`dev-res` 只有 `{id,ok,err}`。
- 命令白名单：`deck.get / bot.add / bot.update / bot.remove / bot.start / bot.stop / bot.switchRoom / buffer.clear`；`deck.update` 不支持（设备名归配置）。
- 质量门：daemon 测试、全量 `npm test`、`npm run build`、`npm run lint` 全绿。

## Review Focus

1. **令牌泄漏**：`device.json` 之外的任何文件/日志/状态帧出现完整 token；`keyHint` 只暴露后 4 位。
2. **命令越权/注入**：未知 cmd、`apiKey` 嵌套、非法 room/id、`bot.update` 越界字段被拒；拒绝文案不回显参数。
3. **中继断线语义**：daemon 重连退避、`dev-replaced` 停止重连、`pair`/`revoke` 在未连接时明确失败而不是挂起。
4. **R20 覆盖错误**：配置改了房仍被旧覆盖抢回；重启后手机切的房蒸发；覆盖写失败拖垮 daemon。
5. **撤销原子性**：`revoke --all` 先落新 token 再发帧；服务端拒绝时回滚本地 token；旧 token 不残留在内存/日志。

---

### Task 1: 设备令牌身份 `device.js`

**Files:** Create `packages/bot-daemon/device.js`、`packages/bot-daemon/tests/device.test.js`

**Interfaces:** `deriveDeviceId(token)`、`createDeviceIdentity({ dir, fileName='device.json', randomBytes? })` → `{ path, token(), deviceId(), rotate(), setToken(token) }`；文件 `{version:1, token}`，原子写，坏文件/缺失 → 新铸令牌。

- [ ] 写失败测试：首启生成 64 hex、重载稳定、坏文件重铸、rotate 换 token/deviceId、setToken 回滚、错误文本不含 token。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): 设备令牌身份文件与轮换（P3b）`。

### Task 2: R20 房间覆盖 `runtime.js` + host 应用

**Files:** Create `packages/bot-daemon/runtime.js`、tests；Modify `host.js`。

**Interfaces:** `createRuntimeStore({ file })` → `{ path, getRoomOverride(id), setRoomOverride(id,{room,baseRoom}), clearRoomOverride(id), list() }`；形状 `{version:1, rooms:{id:{room,baseRoom}}}`；room `/^[a-z0-9]{6}$/`。

- [ ] 测试：读写/坏文件/非法 room 忽略；host boot 应用覆盖、配置房变化清覆盖、快照报有效房。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): R20 房间覆盖持久化（P3b）`。

### Task 3: 中继客户端 `relay-client.js`

**Files:** Create `packages/bot-daemon/relay-client.js`、tests。

**Interfaces:** `createRelayClient({ url, token, name, ver, WebSocketImpl, sleep, now, onCommand, onStatus, onPaired, logger })` → `{ start, stop, requestPair({timeoutMs}), rotate(newToken,{timeoutMs}), pushState(state), status(), paired(), isOpen(), setToken(token), getDeviceId() }`；`/device` URL 拼接；退避 1/2/5s；`dev-replaced` 停止重连；命令自动回 `dev-res`。

- [ ] 测试：auth/配对码/paired/state/命令回执/替换停止/rotate ack/断线重连/stop 清定时器。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): /device 中继客户端（P3b）`。

### Task 4: 命令白名单与状态投影 `commands.js`

**Files:** Create `packages/bot-daemon/commands.js`、tests。

**Interfaces:** `createCommandHandler({ deck, runtime, getConfig, getKeyHint, logger })` → `{ handle({cmd,args}) → {ok,err} }`；`buildDevState(snapshot,{provider,keyHint})`。

- [ ] 测试：白名单逐条、未知 cmd、apiKey 深度嵌套拒绝、非法 room/id、keyHint 只后 4 位、state 无 key。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): 远端命令白名单与状态投影（P3b）`。

### Task 5: 宿主接线 + `pair`/`revoke` 核心

**Files:** Modify `host.js`；tests `host.test.js`。

- [ ] 测试（注入假 link/identity/runtime）：boot 后 meta.deviceId 派生、未配对快照、命令→deck、`dev-state` 周期推送、pair 透传、revoke 先落盘后发帧/失败回滚、shutdown 清定时器。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): 宿主接线设备链路与配对/撤销（P3b）`。

### Task 6: rpc `POST /pair`、`POST /revoke` + CLI `pair`/`revoke --all`

**Files:** Modify `rpc.js`、`cli.js`、tests。

- [ ] 测试：secret 鉴权、405/413、pair 返回码、revoke 返回 deviceId、未连接 503、CLI 用法与输出不含 token。
- [ ] 实现；[ ] 测试绿；[ ] 提交 `feat(daemon): pair/revoke CLI 与回环控制命令（P3b）`。

### Task 7: 文档、门、独立审查

- [ ] spec §11.9 P3b 状态（含运行时修改语义、R20 规则、令牌轮换顺序）；daemon README/deploy README 补 pair/revoke；gates；opus 审查 + 修复。
- [ ] 提交 `docs(daemon): P3b 配对/撤销与 R20 语义`。

## Self-Review 备注

- P3c（浏览器远端 deck）不在本计划；本计划完成后用真 daemon + P3a 服务端跑一次手工 e2e 的替代品（Node 集成测试）。
- `deck.update` 不实现；设备名来自配置。
- 远程 bot 增删/人格修改不持久化是刻意的（Q2 配置拥有定义）；只有 R20 的房间状态例外。
