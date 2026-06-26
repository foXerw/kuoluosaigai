# kuoluosaigai 聊天室技术文档

> 对应实现：`server/index.js`（后端）、`src/composables/useChat.js`（传输层）、`src/components/ChatRoom.vue`（UI）、`src/App.vue`（接入）
> 设计 spec：`docs/superpowers/specs/2026-06-27-kuoluosaigai-chatroom-design.md`

## 1. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Node.js + [`ws`](https://www.npmjs.com/package/ws) | 原生 `http` 起 server，`ws` 的 `WebSocketServer` 挂在上面。无框架、无数据库、无持久化 |
| 传输 | WebSocket（JSON 文本帧） | 全双工长连接，服务端可主动推送（区别于 HTTP 的请求-响应） |
| 前端 | Vue 3（Options + Composition 混用） | `useChat` 组合式封装 WebSocket，`ChatRoom.vue` 渲染 |
| 构建 | vue-cli（前端）/ 独立 `server/package.json`（后端） | 前端静态包，后端独立 Node 进程 |
| 测试 | vitest（前端 jsdom / 后端 node） | 后端起真实 in-process ws server + 真实客户端 |

无 Redis、无数据库、无消息队列、无第三方实时服务。一个 Node 进程 + 一个 `ws` 库就是全部后端。

## 2. 架构

```
┌──────────────┐        WebSocket (wss://)        ┌──────────────────┐
│  浏览器 A     │ <──────────────────────────────> │                  │
│  ChatRoom.vue│                                   │                  │
│  + useChat   │                                   │  Node + ws       │
└──────────────┘                                   │  server/index.js │
                                                   │                  │
┌──────────────┐        WebSocket (wss://)        │  clients: Map    │
│  浏览器 B     │ <──────────────────────────────> │  (内存)          │
│  ChatRoom.vue│                                   │                  │
│  + useChat   │                                   │  broadcast()     │
└──────────────┘                                   └──────────────────┘
```

- 前端仍静态托管（任意 CDN/静态站），通过 `VUE_APP_WS_URL` 知道 ws 端点在哪。
- 后端是一个独立 Node 进程，监听一个端口（默认 8080）。
- 每个浏览器开一个 WebSocket 长连接到后端。后端持有所有活跃连接。

## 3. 数据存在哪里？（重点）

**答：哪里都不持久存——全部在 Node 进程的内存里，进程重启即清零。**

具体地，后端唯一的"状态"是一个 `Map`：

```js
// server/index.js:24
const clients = new Map() // ws -> { nick, times: [] }
```

- 键是每个 WebSocket 连接对象（`ws`），值是 `{ nick, times }`——`nick` 是该连接的匿名代号，`times` 是限速用的发送时间戳数组。
- **消息从不存盘**：服务端收到一条消息，立刻 `broadcast` 给所有在线连接，然后丢弃（`server/index.js:73-79`）。服务端没有任何"消息历史"数组。
- **昵称也只在内存**：连接建立时服务端随机生成 `ANON-XXXX`（`server/index.js:51-53`），存进 `clients` Map，断开即随 `ws` 键一起被 `delete`（`server/index.js:83`）。
- **在线人数** = `clients.size`（`server/index.js:39`），即当前 Map 里有多少个连接。

客户端这边，每个浏览器各自维护一个 `messages` 数组（`useChat.js:8`），**只含自己加入之后收到的帧**。所以：

- 你打开较晚，看不到加入之前的对话——因为没有历史可读。
- 刷新页面 = 旧连接断开、新连接建立 = 拿到一个新昵称、清空本地 messages、只看得到之后的消息。
- 服务端进程重启 = 所有人断线、所有内存清零、重连后重新分配昵称、历史全没了。

这是匿名即焚聊天室的有意设计：不留痕、不持久化、不归属。代价是**无历史回看、无离线消息**。

## 4. 多用户如何进入"同一个聊天室"？（重点）

**答：没有"房间"这个概念，也没有房间 ID。单全局房间 = 一个 WebSocket 广播域。**

实现机制：

1. **所有人连同一个端点**。前端配置 `VUE_APP_WS_URL` 指向后端（如 `ws://localhost:8080`），每个浏览器 `new WebSocket(url)`（`useChat.js:23`）都连到这同一个 ws server。

2. **后端把每条连入登记进 `clients` Map**。`wss.on('connection', (ws) => { clients.set(ws, info); ... })`（`server/index.js:50-53`）——每来一个新连接，就往 Map 里加一项。

3. **"同房间"的本质是 `broadcast()`**：

```js
// server/index.js:30-36
function broadcast(frame, except = null) {
  const data = JSON.stringify(frame)
  for (const ws of clients.keys()) {       // 遍历所有在线连接
    if (ws === except || ws.readyState !== ws.OPEN) continue
    ws.send(data)                            // 给每个连接发同一帧
  }
}
```

   一条消息从用户 A 发出 → 服务端 `broadcast` → 遍历 `clients` 里所有连接 → 每个在线的浏览器都收到。**因为所有连接都在同一个 `clients` Map 里，广播自然覆盖所有人——这就是"同一个聊天室"。** 不需要房间路由、不需要订阅频道、不需要 `join room`。

4. **加入/离开的感知**：
   - 新连接进来：服务端给该连接发 `assign`（分配昵称），给其他所有人广播 `join`（"谁谁加入了"），再给所有人广播 `presence`（最新在线数）——`server/index.js:55-57`。
   - 连接断开：从 Map 删掉，广播 `leave` + 新 `presence`——`server/index.js:82-86`。

所以"多用户进同一房间"不是靠某种 join 逻辑，而是**架构上只有一个广播域**：一个 ws server = 一个 `clients` Map = 一个聊天室。要扩成多房间，才需要给每个连接打 `room` 标签、`broadcast` 时只遍历同 room 的连接（当前未做，见 §7）。

## 5. 通信协议

所有帧都是 JSON 文本，靠 `type` 字段区分。客户端→服务端只有一种；服务端→客户端有六种。

| 方向 | type | 字段 | 说明 |
|---|---|---|---|
| 服务端→客户端 | `assign` | `nick` | 连接建立时发给该客户端，分配匿名代号 |
| 服务端→客户端 | `join` | `nick, ts` | 某人加入，广播给其他人（不含加入者本人） |
| 服务端→客户端 | `leave` | `nick, ts` | 某人离开，广播给其他人 |
| 服务端→客户端 | `message` | `nick, badge, text, ts` | 聊天消息，广播给**所有人含发送者**（统一渲染） |
| 服务端→客户端 | `presence` | `online` | 在线人数，join/leave 后广播给所有人 |
| 服务端→客户端 | `rate` | `ts` | 限速触发，仅发给超限者本人 |
| 服务端→客户端 | `error` | `msg` | 收到非法 JSON 帧，仅回发送者 |
| 客户端→服务端 | `message` | `text, badge` | 用户发言；`badge` 是客户端自报的频道 prefix，服务端原样透传不校验 |

注意 `badge`（频道徽章，如 `SETSUBUN`）：服务端不关心、不验证，由客户端从自己抽到的频道取 `prefix` 塞进帧（`useChat.js:63`），服务端 `String(frame.badge || '')` 原样塞回广播（`server/index.js:76`）。这意味着徽章理论上可被客户端伪造（v1 接受这个信任假设，不做防伪）。

## 6. 关键流程时序

### 加入
```
浏览器A            服务端              浏览器B(已在房)
  │  connect ws ──> │                     │
  │                 │  assign{nick} ──> A │
  │                 │  join{A} ──────────>│  (广播给B，不含A)
  │                 │  presence{2} ──> A ─>│  (广播给所有人)
  │  <── open ──── │                     │
```

### 发消息
```
浏览器A            服务端              浏览器B
  │  message{text,badge} ──> │           │
  │                           │ 校验+截断+限速
  │                           │ broadcast message{nick,badge,text,ts}
  │  <──── 同帧回显 ──────────┤ ──> 收到 │
  │  (含发送者，统一渲染)      │           │
```

### 断线重连（前端，`useChat.js:50-57`）
```
连接断开 → onclose → status='closed'
         → 退避 1s → 重连失败 → 2s → 5s → 5s → 5s…（封顶）
         → 重连成功 → onopen → status='open'，retries 归零
用户主动关闭/卸载组件 → disconnect() → closedByUser=true，不再重连
```

## 7. 边界与限制（v1 有意为之）

- **无消息持久化/历史**：加入前的对话看不到，刷新即丢（见 §3）。
- **单全局房间，无多房间**：所有连接共享一个广播域（见 §4）。要做多房间需给连接打 room 标签并按 room 过滤广播。
- **无登录/封禁**：纯匿名。昵称服务端随机分配、不可自选。
- **徽章可伪造**：客户端自报，服务端不校验（见 §5）。
- **限速/截断很基础**：10 条/分钟/连接、文本 ≤280 字符（`server/index.js:5-7, 42-48, 72`），防刷但不防恶意客户端绕过协议。
- **单进程**：后端是一个 Node 进程，`clients` Map 在该进程内存。多进程水平扩展需引入共享状态（如 Redis pub/sub），当前未做。
- **消息数组无上限**：前端 `messages` 一直 push，长会话会占内存/DOM（v1 可接受）。

## 8. 本地运行

```bash
# 1. 起后端（先装依赖）
cd server
npm install
npm start                 # 默认 8080，可 PORT=xxxx 覆盖

# 2. 起前端（项目根）
cd ..
echo "VUE_APP_WS_URL=ws://localhost:8080" > .env.local
npm run serve             # 默认 8080；若与后端冲突，--port 8081
```

打开两个浏览器窗口访问前端，各自经开机序列 → 进入聊天室，即可看到对方加入/发言/在线数变化。

## 9. 部署

- **前端**：`npm run build` 出静态包，托管到任意静态站（GitHub Pages / Vercel / Netlify 等）。构建时注入 `VUE_APP_WS_URL=wss://你的后端域名`。
- **后端**：`server/` 部署到能跑长驻 Node 进程的平台（Render / Railway / Fly / VPS）。设 `PORT` 为平台分配的端口。注意：纯静态托管（如 GitHub Pages）**不能**跑后端——后端必须有常驻进程。
- **HTTPS/WSS**：生产环境前端是 `https://`，WebSocket 必须用 `wss://`（浏览器会拒绝 https 页面里的 ws://）。后端平台通常自动终止 TLS，或你在反代层（nginx）处理。
