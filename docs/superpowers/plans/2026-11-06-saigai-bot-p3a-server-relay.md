# P3a 服务端设备通道与配对中继实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有聊天服务器上增加第二类连接——设备通道（`/device`）：daemon 设备令牌认证、6 位配对码、浏览器会话、控制帧路由、`devices.json` 持久化与撤销。服务端零新依赖。

**Architecture:** 新文件 `server/devices.js`（令牌派生/持久化）与 `server/relay.js`（设备/会话/配对状态机，注入 `send`/`now`，用假 ws 可单测）。`server/index.js` 只加路径分流：`/device` 走 relay，其余走现有参与者协议。设备连接不占房间席位、不进在线数、不进历史帧流。

**Tech Stack:** Node 内建 `node:crypto`/`fs`/`path`；现有 `ws`；vitest。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §11（P3）、§16.5 Q4/Q8/Q12

## Global Constraints

- 服务端零新增运行时依赖；现有 39 个 server 测试与参与者协议**一字不改**（新增测试除外）。
- 设备连接**不占房间席位、不计在线、不进历史帧流**；参与者连接不能发设备帧。
- **Q5 已定 (a)：API key 永不进中继**。服务端只转发/缓存 daemon 上报的 `dev-state`；不解析、不存储 key；任何帧出现 `apiKey` 字段一律拒绝该帧（P3b 的 daemon 侧再兜底）。
- 令牌：64 位小写 hex（32 字节）；`deviceId = sha256(token) 前 16 hex`（R30）；持久化只存 `sha256(token)`，不存明文令牌。
- 配对码：6 位、60s 过期、一次性、**未知/过期/已用/超会话上限共用同一错误帧**（无枚举预言机）。
- 配对限速：5 次/60s/IP；键优先 `CF-Connecting-IP`，否则 socket 地址（Q8；源站不得对公网开放的前提写进文档）。
- 落盘：`server/data/devices.json`（`KUO_DEVICES_FILE` 可覆盖）；原子写（tmp+rename）；坏文件 fail-closed 为空设备表，不崩服务。
- 质量门：`npm test`（含 server）、`npm run build`、`npm run lint` 全绿。

## Review Focus

1. **设备连接污染参与者面**：设备连接被计入 rooms/online/counts，或 `/device` 收到 `assign`、参与 history 帧流。
2. **配对预言机/枚举**：未知码、过期码、已用码、token 错、session 错、超会话上限的响应可区分；或限速没按 IP 生效。
3. **令牌/密钥泄漏**：`devices.json` 出现明文 token；日志/错误帧带 token；转发帧带 `apiKey`。
4. **路由串房/串设备**：浏览器 A 的 `dev-cmd` 送到设备 B；daemon 的 `dev-res` 发给别的设备；`to` 与自身 deviceId 不符仍被转发。
5. **撤销不彻底**：`revoke-all` 后旧 token/session 仍能认证，或旧浏览器连接仍收状态；单会话撤销后仍能重连。

---

### Task 1: `server/devices.js` 令牌与持久化

**Files:**
- Create: `server/devices.js`
- Test: `server/devices.test.js`

**Interfaces:**
- `isValidToken(v): boolean`、`hashToken(token): string`、`deriveDeviceId(token): string`、`genSessionId(): string`、`genPairCode(): string`
- `createDeviceStore({ file, now? }): { path, load(): doc, get(deviceId), findByToken(token), upsert(deviceId, device), remove(deviceId), list() }`
- 文档形状：`{ version:1, devices: { [deviceId]: { deviceId, tokenHash, name, createdAt, sessions: { [sessionId]: { label, createdAt } } } } }`
- `findByToken` 同时校验 hash 相等；坏文件 → 空表。

- [ ] **Step 1: 写失败测试**：token 形状/派生稳定性/不同 token 不同 id；store 写入→重读→`findByToken` 命中；坏 JSON/错形状→空表不抛；原子写失败不污染内存；`sessions` 清洗（label ≤32、createdAt 数字）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：`node:crypto` sha256；同步原子写（tmp+rename）；白名单净化。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(relay): 设备令牌与 devices.json 持久化（P3a）`。

### Task 2: `server/relay.js` 认证/配对/路由

**Files:**
- Create: `server/relay.js`
- Test: `server/relay.test.js`

**Interfaces:**
- `createRelay({ store, send, now = Date.now, pairTtlMs = 60000, pairClaimLimit = 5, pairWindowMs = 60000, sessionCap = 10, frameLimit = 120, stateMaxBytes = 65536, genCode?, genSession? })`
- 返回 `{ handle(ws, frame, meta), onClose(ws), isDeviceWs(ws) }`；`meta = { ip }`（配对限速键）。
- 帧（c→s）：`dev-auth{role,token,sessionId?,name?}`、`pair-new`、`pair-claim{code,label?}`、`dev-state{state}`、`dev-res{id,ok,err}`、`dev-cmd{to,id,cmd,args}`、`dev-sessions{id}`、`dev-session-revoke{id,sessionId}`、`dev-revoke-all{newToken}`
- 帧（s→c）：`dev-auth-ok{role,deviceId,name,paired}`、`dev-auth-err`、`pair-code{code,expiresMs}`、`pair-ok{deviceId,name,token,sessionId}`、`pair-error`、`paired{deviceId,sessionId?}`、`dev-state{deviceId,state,ts}`、`dev-cmd{from,id,cmd,args}`、`dev-res{id,ok,err}`、`dev-offline{deviceId}`、`dev-revoked`、`dev-sessions-res{id,sessions}`、`dev-revoke-ok{deviceId}`、`rate{ts}`

- [ ] **Step 1: 写失败测试**（假 ws = `{ send(data) }` 记录帧）：
  - daemon 未知 token → `dev-auth-ok paired:false`；已注册 → `paired:true`。
  - `pair-new` → 6 位码；claim → `pair-ok` 返回 token/sessionId、`devices.json` 落盘、daemon 收 `paired`。
  - 同码二次 claim / 过期 / 未知 → 同一 `pair-error`；超会话上限同错误。
  - browser 正确 token+session → `dev-auth-ok` + 缓存状态；错 token/session → 同一 `dev-auth-err`。
  - `dev-cmd` 只送到该 device 的 daemon，`to` 不符丢弃；`dev-res` 回到该 device 的所有浏览器；`dev-state` 缓存并广播。
  - 未知帧/未认证帧被拒且计数限速；120 帧/60s 熔断。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**状态机与帧校验；所有错误路径不抛、不发 token；`apiKey` 字段出现即拒。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(relay): 设备通道认证、配对与路由状态机（P3a）`。

### Task 3: `/device` 分流与真实 WS 集成

**Files:**
- Modify: `server/index.js`
- Test: `server/device-channel.test.js`

- [ ] **Step 1: 写失败测试**（真 server + `ws` 客户端）：`/device` 连接不发 `assign`、不进 rooms/online/counts；参与者连接发 `dev-auth` 被忽略/拒绝；`devicesFile` 指向临时文件，pair→重启 server→browser 用旧 token/session 仍能认证。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：`createServer` 接受 `devicesFile`（默认 env/`server/data/devices.json`）；upgrade 路径 `/device` 交给 relay；`close()` 清理 relay/WS；心跳覆盖设备连接。
- [ ] **Step 4: 运行确认通过 + 现有 39 测试全绿**。
- [ ] **Step 5: 提交**：`feat(relay): /device 分流与真实 WS 集成（P3a）`。

### Task 4: 撤销、会话列表与限速边界

**Files:**
- Modify: `server/relay.js`
- Test: `server/relay.test.js`、`server/device-channel.test.js`

- [ ] **Step 1: 写失败测试**：`dev-sessions` 列会话与在线态；`dev-session-revoke` 后该 session 不能重连、其他 session 不受影响；`dev-revoke-all{newToken}` 后旧 token 全线失效、新 deviceId 生成、旧浏览器收 `dev-revoked`、旧 entry 从 `devices.json` 消失；`newToken` 非法/与现存设备撞 id → 拒且不变。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(relay): 会话撤销与令牌轮换（P3a）`。

### Task 5: 文档、门与独立审查

- [ ] **Step 1: 文档**：spec §11 增加「P3a 实现状态」：`/device` 路径、帧表、devices.json 第二处落盘、CF-IP 前提、revoke 语义；Q5(a) 记录。
- [ ] **Step 2: 门**：`npm test`、`npm run build`、`npm run lint`。
- [ ] **Step 3: 独立审查**（fresh reviewer，opus），按 Review Focus；Critical/Important 修复并补失败测试。
- [ ] **Step 4: 提交**：`docs(relay): P3a 协议与运维边界`。

## Self-Review 备注

- 覆盖 spec §11.2/§11.3/§11.4/§11.6/§11.7 的服务端半边；daemon 客户端与浏览器面板在 P3b/P3c。
- `pair-new` 由已认证 daemon 连接发起（P3b 经本地 rpc 触发），服务端不用第二类引导连接；令牌明文只在内存中供 `pair-ok` 返回，磁盘只存 hash。
- 首次配对与追加浏览器共用同一路径：设备不存在则建条目，存在则加 session。
- `bot.update` 等命令的语义与持久化归 P3b；服务端只做白名单长度/大小/路由，不解释 cmd。
