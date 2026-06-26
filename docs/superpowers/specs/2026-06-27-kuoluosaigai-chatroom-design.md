# 真聊天室设计 · kuoluosaigai v2

- 日期：2026-06-27
- 范围：把 v1 的占位聊天入口（ChatPlaceholder Modal）升级为真实匿名聊天室——Node + WebSocket 自托管、随机昵称、单全局房间、频道徽章
- 上游 spec：`docs/superpowers/specs/2026-06-26-kuoluosaigai-homepage-design.md`（第 1 节"下轮接 WebSocket 做真聊天"）
- v1 现状：`CenterGate @enter → App.openPlaceholder → ChatPlaceholder`（Ant Design Modal，"频道尚未开放"占位）。部署纯静态，无后端
- 不在本轮范围：多房间、消息持久化/历史、图片/富媒体、@提及、登录/封禁系统、移动端深度适配

## 1. 叙事 / 体验

访客经过开机序列 + 扫描线 wipe 进入主界面（v1.1 已完成），点击中央「进入聊天室」入口 → 全屏终端风聊天覆盖层。服务端即时分配一个匿名代号（`ANON-XXXX`），用户消息带其抽到的频道徽章（如 `SETSUBUN`）显示。消息即焚：加入后只看到之后的消息，无历史。在线人数为真实服务端计数（替换 v1 ChannelShell 的假值，但 ChannelShell 顶栏的假值本轮不动——见范围边界）。断线自动重连。

## 2. 组件边界与目录

```
server/
  index.js              # Node + ws 单文件：连接/昵称/广播/在线计数/限速/长度截断
  package.json          # 独立：ws 依赖 + start 脚本
src/
  composables/useChat.js   # 传输+状态：连接/昵称/消息/在线数/send/重连
  components/ChatRoom.vue  # 终端风全屏聊天 UI（替换 ChatPlaceholder）
  App.vue                  # openChat() 渲染 ChatRoom；保留 channel 做徽章
  theme/channels.js        # 复用 codename() / prefix 做用户频道徽章
```

`ChatPlaceholder.vue` 退役删除。`CenterGate` 不变（仍 `@enter`）。`App.vue` 的 `openPlaceholder` 改名 `openChat`，渲染 `ChatRoom` 替换占位。

## 3. 后端 `server/index.js`

单文件 Node + [`ws`](https://www.npmjs.com/package/ws)。无框架、无持久化、单全局房间。

- **连接**：服务端生成随机昵称 `ANON-XXXX`（4 位大写字母数字，剔除歧义字符 O/0/I/1），发 `assign` 帧给该客户端；广播 `join` 帧（含昵称）给其他客户端；维护 `clients` Map（`ws → { nick }`）。
- **消息**：收客户端 `{type:'message', text, badge}`（`badge` = 客户端当前频道 prefix），校验：
  - `text` 截断 ≤ 280 字符；
  - 限速：每客户端 ≤ 10 条/分钟（滑动窗口），超限丢弃并回 `rate` 帧，不广播；
  - 通过则广播 `message` 帧 `{nick, badge, text, ts}` 给**所有**客户端（含发送者，统一渲染）。服务端原样透传 `badge`，不校验、不依赖频道知识。
- **在线计数**：每次 join/leave 后广播 `presence` 帧 `{online}`。
- **断开**：广播 `leave` 帧 + 更新 `presence`。
- **协议**：所有帧 JSON，`type` 字段区分 `assign | join | leave | message | presence | rate | error`。
- **启动**：`PORT` 环境变量（默认 8080）。

`server/package.json`：`{ "name":"kuoluosaigai-server", "private":true, "type":"module", "scripts":{"start":"node index.js","test":"vitest run"}, "dependencies":{"ws":"^8.18.0"}, "devDependencies":{"vitest":"^4.1.9"} }`。

## 4. `useChat` 组合式 + 数据流

`useChat(url)` 返回 `{ status, nick, messages, online, send(text), connect(), disconnect() }`。

- `status`：`'connecting' | 'open' | 'closed'`（`ref`）。
- `nick`：`ref<string|null>`，收到 `assign` 帧后写入。
- `messages`：`ref<Array<{type, nick?, text?, ts}>>`，按帧 type 追加（`message`/`join`/`leave`/`rate`）。
- `online`：`ref<number>`，`presence` 帧更新。
- `send(text)`：仅 `status==='open'` 时发 `{type:'message', text, badge}`（`badge` 由组件传入或 useChat 初始化时给定）。
- 内部 `WebSocket`：onopen→status `open`；onmessage→按 type 分发更新状态；onclose→status `closed`，触发重连退避 `1s → 2s → 5s` 封顶，自动重试；onerror 不额外处理（由 onclose 兜底）。
- `connect()`：`url` 为空时 no-op（`status` 保持 `closed`，不发起连接，配合离线降级）。
- 组件 unmount 时 `disconnect()`：清重连定时器、关 socket。

数据流：
```
CenterGate @enter → App.openChat() → ChatRoom 挂载 → useChat(url).connect()
→ 服务端 assign nick + presence → ChatRoom 渲染
→ 用户输入 → send() → 服务端广播 → 所有客户端 messages 更新 → 列表 auto-scroll 到底
→ 关闭 → App.openChat=false → ChatRoom 卸载 → useChat.disconnect()
```

## 5. ChatRoom UI（布局 A · 经典 IRC）

全屏覆盖层，终端风，主色随频道 `--app-color`。三段式：

- **顶栏**：左 `● CHANNEL // GLOBAL`，右 `● {online} online · {status}`（status 文案：`connected`/`connecting…`/`offline`）。
- **消息流**（flex:1，溢出滚动，auto-scroll 到底）：
  - 系统消息（join/leave/rate）：`{time} {sys 文案}`，半透明斜体。
  - 聊天消息：`{time} {频道徽章} {nick} > {text}`。徽章 = 该用户抽到的频道 `prefix`（如 `SETSUBUN`），边框小标签；nick 用稍亮主色。时间 `HH:MM`。
- **输入栏**：`> {输入框}` + 回车发送；`status!=='open'` 时禁用并提示 `offline`；空文本不发。
- **关闭**：右上 `✕` 或 Esc 键关闭（emit `close`）。
- `prefers-reduced-motion`：无进入动画，直显；auto-scroll 仍生效。

频道徽章来源：纯客户端概念。客户端发 `message` 帧时附带 `badge`（当前频道 `prefix`），服务端原样透传广播（见 §3）。服务端保持无状态、不依赖频道知识。徽章防伪造不在本轮范围（见边界）。

## 6. 部署 / 环境配置

- **前端**：仍 `vue-cli-service build` 静态包。WS 端点经 `VUE_APP_WS_URL` 注入：dev `.env.local` = `ws://localhost:8080`，prod `.env.production` = `wss://your-server`。`useChat` 读 `import.meta.env`？——vue-cli 用 `process.env.VUE_APP_WS_URL`，由 App 读取后传入 `useChat(url)`。未配置/为空时 `ChatRoom` 降级显示"频道离线 · channel offline"文案，不连网（沿用 v1 占位语义，不崩）。
- **后端**：`server/` 独立 `package.json`，部署到 Render/Railway/Fly/VPS 任选（用户自定）。根 `package.json` 不混入 server 依赖，前端构建保持干净。
- **lint**：根 `eslintConfig` 加 `ignorePatterns: ["server/"]`，避免前端 eslint 误报 server 代码；server 不引入 eslint（vitest 即可）。

## 7. 错误处理 / 降级

- `VUE_APP_WS_URL` 未配置 → ChatRoom 显示离线文案，不发起连接。
- 连接失败/断线 → `status='closed'`，顶栏显示 `offline`，输入禁用，自动重连退避。
- 服务端限速触发 → 客户端收到 `rate` 帧，消息流追加一条系统提示 `rate limit — slow down`。
- 超长文本 → 服务端截断后广播，客户端不预截断（简单）。
- `prefers-reduced-motion` → ChatRoom 无进入动画直显，传输层重连逻辑不受影响（传输非视觉）。

## 8. 测试

**`server/index.test.js`**（node 环境，vitest）：
- 起 in-process ws server（随机端口）+ 测试 ws 客户端连接。
- 连接后收到 `assign` 帧（含 `nick` 形如 `ANON-XXXX`）+ `presence.online===1`。
- 发 `message` → 自己收到 `message` 帧（nick/text/ts）；文本 >280 字符被截断；第 11 条/分钟触发 `rate` 帧且不广播。
- 第二客户端连入 → 第一客户端收到 `join` + `presence.online===2`；断开 → 收到 `leave` + `online===1`。

**`useChat.test.js`**（jsdom，注入 mock `WebSocket` 到 global）：
- onopen → `status==='open'`。
- 收 `assign` 帧 → `nick` 更新。
- 收 `message` 帧 → `messages` 增长。
- `send` 在 `status!=='open'` 时不发。
- onclose → `status==='closed'` 且调度重连（用伪定时器验证退避）。
- unmount → `disconnect()` 清定时器、关 socket。

**`ChatRoom.test.js`**：
- 渲染消息列表（含徽章/nick/text）、在线数、status。
- 输入文本回车 → 调 `send`；空文本不发；`offline` 时输入禁用。
- 关闭按钮/Esc → emit `close`。

**`App.test.js` 扩展**：
- `enter` → 打开 `ChatRoom`（替原 ChatPlaceholder 断言）。
- 无 `VUE_APP_WS_URL` → ChatRoom 降级文案（或 App 不传 url，ChatRoom 内部降级）。

## 9. 范围边界

做：

- ✅ Node+ws 单全局房间、随机昵称（不可自选）、频道徽章
- ✅ 纯文本 + 限速（10/min）+ 长度截断（280）
- ✅ 真实在线计数、断线重连退避
- ✅ 全屏终端 ChatRoom（布局 A）、auto-scroll、Esc/✕ 关闭
- ✅ `VUE_APP_WS_URL` 环境配置 + 离线降级
- ✅ server + useChat + ChatRoom + App 测试

不做：

- ❌ 多房间、消息持久化/历史、图片/富媒体、@提及
- ❌ 登录/封禁/徽章防伪造（徽章客户端自报，本轮信任）
- ❌ ChannelShell 顶栏假在线值改真值（仅 ChatRoom 内的在线数为真；ChannelShell 不动，避免范围蔓延）
- ❌ 移动端深度适配（基本可用）
