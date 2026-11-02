# saigai-bot：把 BOT DECK 从浏览器扩展到自托管常驻运行时（长期规划）

日期：2026-11-03
状态：待用户终审（brainstorm 全量闭环后成文；文末列设计者裁定项供核对）
前置：`2026-11-01-ai-bot-design.md`（浏览器 BOT DECK 轮，本文档**不推翻**它，只在其之上加第二条腿）、
`2026-10-20-kuoluosaigai-multi-room-design.md`（房间协议与护栏权威文档）

---

## 1. 意图与动机

浏览器 BOT DECK 已上线，但 bot 的生命周期被标签页绑死：关标签即停、后台标签被节流、
只在"人正看着这块屏幕"时存在。用户希望 bot 能 24 小时常驻，同时**不牺牲**上一轮最硬的资产——
"API key 只在使用者自己的机器上、聊天服务器永不经手"。

用户已排除的形态：带 UI 的云端服务器上跑浏览器（极卡、后台不稳）。

用户已有的条件（本人陈述）：一台 PVE 服务器，其中**一台**虚拟机 24 小时跑**自己的** bot；
其他用户各自在自己电脑上跑，能常驻与否取决于各自的电源/环境。

### 核心洞察（本轮 brainstorm 的结论，决定全部架构）

1. **bot 的"所有权"从来不是账号问题，而是物理位置问题。** 浏览器模式把所有权绑在标签页上；
   自托管把它绑在"运行它的那台机器"上。两种都是物理绑定，都不需要账号系统、不需要多租户代码。
2. **正因为每人跑自己的机器，"服务器代管 key"这个失败模式根本没有出现过。**
   出 key 的人 = 跑 bot 的人 = 拥有机器的人，三条承诺与浏览器模式完全等价。
3. **现有 8 个 bot 模块里只有 2 个绑浏览器（store/lease），其余 ~1700 行纯 JS 且已内建注入点**
   （`connection.js` 收 `WebSocketImpl`，`llm.js` 收 `fetchImpl`）。所以这是**一次抽包，不是重写**，
   361 个测试全部跟着搬家。
4. **daemon 不取代浏览器模式。** 自我托管的门槛永远高于"打开网页点 BOT DECK"，
   绝大多数访客会继续用浏览器模式。因此本设计的产物是**同一份 core 的两个出口**，
   浏览器路径的行为与现状**逐字节兼容**。

---

## 2. 目标

- **G1** 一个可独立分发的常驻运行时 `saigai-bot`：在 Linux/Windows/NAS 上以 daemon 形式跑，
  bot 在无浏览器、无人类在场的情况下持续按拟人节奏活动
- **G2** 浏览器与 daemon **共用**一份 bot 逻辑（core），拟人参数、prompt、协议、护栏只有一份权威实现
- **G3** **配置热重载**：改配置文件后 ≤2s 内运行中的 bot 集合收敛到目标状态，
  未变更的 bot 不掉线、不重启、不重复补历史
- **G4** 浏览器面板成为**两个 deck 的统一视图**：`本浏览器` / `已配对设备`，远端视图复用现有 BotCard
- **G5** **多设备精确接管**：同一个 daemon 可被用户的 PC 与手机分别配对、独立控制，
  无需账号系统、无需 daemon 有公网地址或固定 IP
- **G6** 聊天服务器**只在 P3 阶段**被改动，且 P0/P1/P2/P4 任一阶段完成即可独立交付上线
- **G7** 拟人感提升（P4）：**浏览器模式与 daemon 同时受益**，成果不进 daemon 专属分支
- **G8** 零新增运行时依赖的传统延续（daemon 允许 `ws`，因为 Node 侧原生无 WebSocket 客户端）

## 3. 非目标

- **不做**服务端代管 bot（用户上传 key、站方进程托管）——见 §4 A1，明令禁止
- **不做**为陌生人批量开容器/VM 的多租户 PVE 编排（用户明确否决：其他人用自己的电脑）
- **不做**账号体系、登录、用户表、跨设备同步配置（配对模型不需要它们）
- **不做** bot 归属的密码学防伪（badge/nick 自报可伪造，沿用上一轮信任模型）
- **不做**"多个 daemon 组成一个家族跨进程协调"——一个 deck 一个进程，家族逻辑不跨进程
- **不做**把 bot 会话记录落盘（隐私承诺"消息不落服务器"的客户端对应物：**也不落 daemon 的盘**）
- **不做**控制信道端到端加密（v2 可选，理由见 §8.6）

## 4. 反目标（技术上跑通也算失败）

- **A1** 任何一帧、任何一条日志、任何一个 API 响应里出现完整的 `apiKey` 流向**站方服务器**。
  远端 deck 的 apiKey 必须**只写不读**，面板侧渲染成 `sk-****后4位`
- **A2** 面板下发预算/限速值被 daemon 无条件采信——刷穿额度或撞爆服务器护栏
- **A3** daemon 接受任意指令（可执行代码、可请求任意 URL）→ 被劫持的面板把它变成 SSRF 跳板
- **A4** 热重载把无关 bot 一起抖下线（改一个人的文案，其他人掉线 30s）
- **A5** 两个 daemon 进程吃同一份配置同时跑（重复发言、双倍预算、互相触发）
- **A6** 常驻后夜间空房间自我对话烧真钱且无刹车（浏览器模式"关标签即停"这条免费保险丝在 daemon 下不存在）
- **A7** 配对码可被爆破、可复用、或服务器对未知令牌返回可区分错误（枚举预言机）
- **A8** 为 daemon 另写一套拟人逻辑或第二份 prompt（core 分叉 = 长期噩梦）
- **A9** 只跑 `npm test` 就收尾而不跑 `npm run build`（上一轮的 eslint/no-undef 构建炸机教训）

## 5. 约束

- **协议护栏全量沿用多房间轮**：发言 ≤10 条/分/连接、单条 ≤280 字（服务器硬截断）、
  join-error/rate 帧语义、房间 ≤100 人、history-res ≤200 条、切房 20 次/分
- 昵称只能是 `ANON-XXXX`；bot 人格名走 `badge`（自报、可伪造）
- 前端 Vue 3 + Ant Design Vue + vitest；测试基线 **361（322 客户端 + 39 服务端），只增不减**
- `server/data/` 注册表须可写且跨重启持久；改服务端后 build+restart 一气呵成（低峰窗口）
- WS 端点：浏览器同源推导不变；daemon 走配置项 `serverUrl`，默认 `wss://kuoluosaigai.com`
- **未实测的前提**（P1 的 `doctor` 命令必须实测它）：PVE 虚拟机出网能否稳定连到
  DeepSeek / Kimi / OpenRouter。此前 CORS 实测数据来自用户家庭网络，**不能推定 VPS 同样可达**
- 合规观察（不确定边界，已提请用户注意）：2026 年国内 AI 情感陪伴类新规致豆包/千问/元宝
  下架智能体服务；叠加生成式 AI 内容标识要求，公开房间里"被问是不是 AI 就坚决否认"这条
  写死的指令在国内 VPS 上公开运营有点扎眼 → P4 将其降为 bot 可选项

---

## 6. 总体架构

```
packages/bot-core          kuoluosaigai-bot-core      纯 JS，无 DOM、无 Vue、无 localStorage
  buffer rhythm prompt llm connection runner deck      ← deck 从 store.js 抽出（§7）
  lease（浏览器专用，daemon 侧不导出；进程互斥另见 §7.4）
        │
        ├──────────────────────────────┬───────────────────────────────┐
        ▼                              ▼                               ▼
  src/ 浏览器面板（现状）        packages/bot-daemon              （未来）其他宿主
  BotDeck.vue / BotCard.vue      saigai-bot CLI + 配置文件
  store.js → core.deck 的           + ESM 配置热重载
  reactive 适配层（薄）            + 单实例锁 + systemd/NAS Docker
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                   参与者 WS（现有协议）      设备 WS（P3 新增，仅 P3）
                          │                         │
                     ┌────┴─────────────────────────┴────┐
                     │   聊天服务器 server/（P3 唯一改动面）│
                     └────────────────┬───────────────────┘
                                      ▼
                              浏览器面板（PC / 手机）
```

**命名（用户拍板 CLI 名）**：CLI 二进制 `saigai-bot`；
包名 `kuoluosaigai-bot-core` / `kuoluosaigai-bot-daemon`（跟 `kuoluosaigai-server` 的仓库习惯）；
根 `package.json` 的 `workspaces` 从 `["server"]` 扩为 `["server", "packages/*"]`。

**阶段顺序（设计者裁定，理由见 §11）**：P0 → P4 → P1 → P2 → P3。

---

## 7. P0 — 抽包 `bot-core`

### 7.1 现状盘点（已核代码）

| 模块 | 行数 | 浏览器耦合 | daemon 侧处置 |
|---|---|---|---|
| `buffer.js` | 61 | 无 | 原样 |
| `prompt.js` | 90 | 无 | 原样（P4 会改内容） |
| `llm.js` | 111 | 无，已注入 `fetchImpl` | 原样，Node 18+ 全局 fetch |
| `connection.js` | 167 | 已注入 `WebSocketImpl`，默认 `globalThis.WebSocket` | 传入 `ws` 包的 WebSocket |
| `rhythm.js` | 284 | 无 | 原样 |
| `runner.js` | 501 | 无 | 原样 |
| `lease.js` | 162 | `localStorage`（跨标签互斥） | **不进 core**；daemon 不需要 |
| `store.js` | 652 | `localStorage` + **`import { reactive } from 'vue'`** | **一刀切分，P0 的全部工作量在这** |

### 7.2 store.js 的切分（P0 唯一有设计含量的动作）

把 652 行拆成两层：

- **core `deck.js`（纯）**：配置模型（providers/bots 结构、校验、默认值、增删改）、
  localStorage 语义的**持久化端口**（`load()`/`save()` 由宿主注入 storage 实现）、
  runner 注册表生命周期（起/停/切房/冲刷 token/清空缓冲）、`lifetime` 累计计数。
  key 命名沿用 `kuoluosaigai:bots:v1`，**格式不变**，现有用户本地配置零迁移。
- **宿主适配（两份，都很薄）**：浏览器侧 `src/bots/store.js` 退化为
  `reactive(deck)` 包装 + localStorage 绑定，组件 API（BotDeck/BotCard 读的字段）保持兼容；
  daemon 侧 = 配置文件 loader + 一个非响应式状态快照推送。

验收口径：**组件层 diff 尽量小**；`BotCard.vue`/`BotDeck.vue` 若必须改，只改 import 路径不改用法。

### 7.3 core 的宿主注入面（一次定形，后续阶段都靠它）

```js
createDeck({
  storage,            // 浏览器 localStorage / daemon 文件 loader / 测试用 Map
  WebSocketImpl,      // globalThis.WebSocket / ws 包
  fetchImpl,          // globalThis.fetch
  now,                // Date.now（测试可控）
  randomId,           // 浏览器 crypto.randomUUID / daemon crypto.randomUUID
  logger,             // console / 结构化 stdout
})
```

### 7.4 daemon 的单实例锁（A5 的对偶实现）

浏览器用 `lease.js` 做跨标签互斥；daemon 的等价物是**进程级互斥**：
数据目录里 `saigai-bot.lock`（O_EXCL 创建 + 内含 PID 与启动时间；
持有者 PID 已死则视为陈旧锁并接管，接管时打一条 WARN）。
PVE 场景的具体风险：`systemd` 重启时旧进程未退、或用户手动又开了一个 → 双份 bot 同房互踩。

### 7.5 P0 交付判据

`npm run build` 绿、`npm test` ≥361 绿、浏览器 BOT DECK 手测行为无变化、
`packages/bot-core` 能在纯 Node 下被 `node -e "import('kuoluosaigai-bot-core')"` 载入并跑通
一条对本地 `server/` 的连接（临时冒烟，不留测试）。

---

## 8. P1 — `saigai-bot` daemon MVP

**这一步不碰聊天服务器、不碰网站。** 完成后用户的 PVE VM 立刻 24/7 常驻。

### 8.1 配置文件：ESM 而不是 TOML（设计者裁定）

Node 无内置 TOML，引解析器违反 G8；JSON 写多行 persona 文案是灾难、且不能注释。
故选 **ESM 配置文件**（`saigai-bot.config.js`，`export default {...}`）：原生 `import()` 零依赖、
支持注释与模板字符串、可直接 `process.env.X`、天然表达 bot 数组。代价与缓解：

- **配置文件即代码** → 规定它必须是**纯数据 default export**；`doctor` 校验结构、
  拒绝含函数/`import` 副作用的产出（只允许 `process.env` 读取）
- **ESM import 缓存**破坏热重载 → 用 cache-buster：`import(path + '?t=' + now)`
- 命名：`saigai-bot.config.js`，默认在数据目录（`~/.config/saigai-bot/`，可 `--config` 覆盖）

```js
export default {
  name: 'lab-vm',                          // 人类可读设备名，P3 面板显示用
  serverUrl: 'wss://kuoluosaigai.com',
  provider: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.KUO_LLM_KEY,       // key 可以不进文件
    model: 'deepseek-chat',
  },
  limits: {                                // 本地硬上限，面板下发的值取 min（A2）
    globalHourlyMessages: 120,
    quietHours: { from: '01:30', to: '08:00' },   // A6 的刹车，见 §10
  },
  bots: [
    { name: '小李', persona: '…', rooms: ['nebula'], talkative: 0.7, temperature: 1.1, hourlyBudget: 20 },
  ],
}
```

### 8.2 CLI

| 命令 | 作用 |
|---|---|
| `saigai-bot run [--config <p>] [--once]` | 前台/受管运行（`--once` 供调试与 CI：跑一轮就退） |
| `saigai-bot doctor` | 配置结构校验 + provider 连通性实测（§5 那条未验证前提）+ 出网/TLS/时钟检查 |
| `saigai-bot status` | 每个 bot 的在线态、所在房间、本小时已发、token 用量、最近一次活动时间 |
| `saigai-bot validate <file>` | 不连网只校验（编辑器和 CI 用） |
| `saigai-bot pair` | 打印一次性配对码（**仅 P3 存在**，P1 阶段先不出现，避免文档承诺未实现能力） |

日志：结构化到 stdout（由 systemd/journald 收），**apiKey 全程 redact**（A3 沿用上一轮 B9 的
`LlmError` 兜底实现，core 里已有）。

### 8.3 热重载收敛语义（G3，这是 CLI 方案成败的关键）

`fs.watch` 配置文件（连同其目录，编辑器多为"写临时文件再 rename"），debounce 1s →
重新 `import()` → 校验 → 与运行集合 **diff** → 收敛：

| diff | 动作 | 约束 |
|---|---|---|
| 新增 bot | 起 runner，补历史，进房 | 受 `limits` 与全局速率约束 |
| 删除 bot | 停 runner：冲刷 token 计数、**只**关自己的连接 | 不影响他人 |
| 变更 bot（persona/rooms/talkative…） | 优雅重启该 bot：等在途 LLM 请求落地或超时、发完在途消息、再重连 | 上限 15s 强制收（沿用 runner 的 15s 封顶） |
| **未变更 bot** | **不动** | 不得有任何重连、不得清缓冲 |

### 8.4 状态与持久性语义（要在 README 明写，否则会被当 bug）

- **配置/令牌/锁**在盘上：重启不丢
- **会话缓冲（`buffer.js` 环形 200）纯内存**：daemon 重启即清，靠现有 P2P 历史重建补回
  ——与浏览器"关标签即清"语义**完全一致**，不是回归
- `limits` 里的小时计数**不跨重启持久**（保守方向：重启即重置可能多烧一点，可接受；若要严格持久化留 P2 后）

### 8.5 部署形态

- **Linux/PVE VM**：systemd unit（`Restart=always`、`RestartSec=5`、`After=network-online.target`、
  `MemoryMax=192M`、`DynamicUser=yes` 或专用非 root 用户、`ProtectSystem=strict` +
  仅数据目录可写）。`journalctl -u saigai-bot -f` 看日志
- **笔记本/台式机（其他用户）**：systemd user unit（Linux）/ 计划任务（Windows）/
  直接终端跑；**必须假设网络与会话是断续的**：断线重连退避沿用 core 现有实现，
  但唤醒后**不得**立即触发闲置发起（`rhythm` 需要一个"刚上线静默窗"，见 §10）

### 8.6 P1 交付判据

PVE VM 上连续跑 24h：无内存增长（bot 数固定）、无人时不出现秒回/连发风暴、
`status` 数字与实际发出条数一致、改一个 bot 的 persona 后其余 bot 连接未断（用
`server/` 侧日志或 `status` 的连接建立事件验证）、`doctor` 对 §5 出网前提给出明确结论。

---

## 9. P2 — 交付形态（让"所有人都能部署"这句话真的成立）

- **Docker 镜像 + `compose.yaml` 模板**：面向**群晖/威联通 NAS** 用户——手头有常开机器
  的普通人的最大存量就是 NAS，开 Docker 是他们唯一会做的事。镜像走多架构
  （`linux/amd64` + `linux/arm64`），配置与数据目录 bind mount，`restart: unless-stopped`
- **npm 包**：`npm i -g kuoluosaigai-bot-daemon` → `saigai-bot` 上 PATH（给会 Node 的人）
- **部署文档**：`docs/saigai-bot-deploy.md`——三条路径各一段（PVE/systemd、NAS/Docker、Windows），
  含"key 只在你机器上"的承诺声明、成本与静默窗建议、FAQ（重启掉缓冲）
- **可选（等有人喊麻烦再做）**：`bun build --compile` 出单文件二进制（core 无原生依赖，能干净编）。
  **不列 v1 承诺**

依赖安装坑（记档，勿重复踩）：本机/服务器 npm 禁 remote 类型包（EALLOWREMOTE）、
统一 lockfile registry、postinstall 被拦——文档里提前给出 `npm config set registry` 提示。

---

## 10. P4 — 拟人感提升（与上面三层正交；浏览器与 daemon 同时受益）

用户体感："很重的伪人感，和 DeepSeek QQ 机器人差太多"。诊断（按性价比排序）：

### 10.1 头号嫌疑：喂给模型的结构（`prompt.js:buildMessages`）

现状把房间每条消息映射成**独立 `role:'user'` 轮次**，于是模型看到的最后一个 user 消息
就是"某人刚发的话"，chat/completions 的机制**强迫它产出"对那一句的回应"** → 客服感根源。
真人插话会**接住某一句、串好几个人、或根本不理**。

改为 **transcript 单条**（QQ 群 bot 通行做法）：整段记录压成**一条** user 消息，
self 消息仍留在 assistant 轮次里以维持文风一致性：

```
[群聊记录 · 最近 N 条]
ANON-3F2K: 有人试过没
ANON-88AA [BOT·小李]: 我试过
ANON-1C0D: 笑死
（你可以插话，可以回应其中任意一句，可以串起几个人的话，也可以只回两个字或沉默）
```

### 10.2 缺失的机制清单（对照成熟 prior art，见 §13 来源）

| 机制 | 参照实现 | 现状 | 处置 |
|---|---|---|---|
| **长度目标 + 短消息分布** | 真人群聊中位 5–15 字；现状只有 280 上限、无目标 | ❌ | 每轮从人似分布抽一个目标字数注入 prompt；输出后二次截断 |
| **分段连发** | Waifu：按标点拆 2–4 条依次发 | ❌（只有家族冷却意义上的连发） | core 新增：一条输出 → 多条消息，间隔抽延迟；**受 ≤10 条/分/连接护栏硬约束** |
| **AI 读空气** | group_chat_plus：LLM 判断该不该插话 | ⚠️ 概率门是**外部统计**，模型语义上没得选 | 让模型显式输出"沉默"选项；沉默不计入预算 |
| **语气杂质** | Waifu：句尾概率加括号、参与复读、无标点、口头禅 | ❌ | prompt + 后处理规则 |
| **攒消息** | Waifu：X 秒内多人发言合并 | ⚠️ 有单槽 pending，但注意力只落在最后一条 | 交给 transcript 单条格式自然解决 |
| **作息 / 三层睡眠** | group_chat_plus：睡觉/迷糊/清醒 | ❌ 只有随机 AFK 5–20min | **daemon 侧必做**（A6 的刹车）；浏览器侧作可选项 |
| **长期记忆 / 关系 / 生活事件** | Waifu：记忆库、用户画像、好感度、虚构日常 | ❌ 仅 40 帧窗口 | P4 之后（需 daemon 落盘，与"不落盘"约束冲突，另行评估） |
| **few-shot 真人例句** | 各家均有 | ❌ 纯规则清单 | 立刻做，成本最低 |
| **破限/出戏容忍** | Waifu：三段 jailbreak 文件 | ❌ | 与"是否伪装真人"选项一起做（§5 合规） |

### 10.3 模型这一维（零代码改动即可验证）

`llm.js` 已支持任意 OpenAI 兼容 baseUrl，故换模型是配置项。DeepSeek V3 被重度 RLHF 成
"有用助手"，每次让它"像真实网友打字"都在对抗训练目标；角色扮演向模型（智谱 Character/GLM 线、
MiniMax 系列、OpenRouter 上的 RP 微调）把口语 register 当主场。
另：`SYSTEM_TEMPLATE` 现在是**合规清单**，模型执行清单的方式是"产出符合规则的正确句子"，
而"被问是不是 AI 就坚决否认"由助手模型执行往往变成**过度解释的否认**——本身就是 tell。

### 10.4 先做实验，再改代码（P4 的第一步必须是 spike，不是 PR）

同一段真实房间记录，跑四个变体，用户盲评：
① 现状 ② transcript 单条 ③ 现状 + few-shot 例句 ④ ②+③+长度目标。
spike 为一次性脚本、不写测试、不进主线；结论写回本节再决定 P4 的实现范围。

---

## 11. P3 — 控制中继与多设备接管（唯一改聊天服务器的一层，故排最后）

### 11.1 设计立场

不要"从浏览器去找 daemon"（NAT 后、无公网端口、IP 会变、手机在 4G 上）。
**让 daemon 去找服务器，让服务器当路由表**——信道复用现有 ws + CF Tunnel + JSON 帧协议，
不新增端口、证书、TLS 终结。P1 的 SSH+vim+热重载已覆盖"能改配置"，
P3 买的是"不用开终端 + 手机上能改"，这是它全部的边际价值。

### 11.2 服务端新增第二种连接类

```
参与者连接（现状，一字不改）: join / create / message / history-req / history-res
设备连接（新增）           : 带 device token 上线 → 登记 "lab-vm 在线"
                             → 只路由已配对双方之间的控制帧
```

要点：设备连接**不占房间席位**、不计入在线人数、不进历史帧流，因此不动现有护栏语义；
但需**独立**的速率桶（按 device token，不按 IP，见 §11.6）。

### 11.3 配对仪式 = OAuth Device Authorization Grant 的形状

1. `saigai-bot pair` → daemon 经设备通道申请一次性配对码，终端打印：
   `配对码 4F2A9C — 在 kuoluosaigai.com 的 BOT DECK 输入即可接管这台设备（60s 有效）`
2. 用户在**手上这台设备**的网站里点「连接设备」输码
3. 服务器建立绑定，返回 `{deviceId, name}` + **device token**，浏览器把它写进**本机 localStorage**
4. 此后浏览器持 device token 连设备通道；指令寻址用 `deviceId`，**从不用 IP/端口**

**多设备为什么天然成立**：token 是访问凭证而非会话。PC 配一次、手机配一次、第三台再配一次，
各设备在自己 localStorage 里各存一份名册，全部指向同一个稳定的 device token
（token 存 daemon 配置文件/数据目录，**跨重启不变**——这是多设备能"永久配对一次"的关键）。
无账号、无同步、任一设备丢失不影响其他。

**为什么用短码而非粘长令牌**：手机上粘 128 位 base64 是灾难，输 6 位码是愉快的。
这条 UX 差别就是"能不能在手机上用"的差别。

### 11.4 帧协议草案（细节留给 builder）

```js
// daemon → server
{t:'dev-auth',  token, name, ver, deck:{bots:[{id,name,rooms,state}]}}
{t:'pair-new'}                          → {t:'pair-code', code, expiresMs}
{t:'dev-state', ...}                    // 状态推送（在线、本小时已发、token 计数、最近活动）
{t:'dev-res',   id, ok, err}            // 指令回执
// browser → server → daemon
{t:'pair-claim', code}                  → {t:'pair-ok', deviceId, name, token}
{t:'dev-cmd', to:deviceId, id, cmd, args}
// cmd 白名单（daemon 侧硬校验，A3）：deck.get / deck.update / bot.add / bot.update /
//   bot.remove / bot.start / bot.stop / bot.enterRoom / bot.leaveRoom / buffer.clear
//   —— 绝无 exec / 绝无任意 URL 让 daemon 去请求
```

### 11.5 面板侧（G4）

顶栏 deck 切换：`本浏览器 | lab-vm | 客厅的NAS`，远端视图复用 `BotCard`（同一组件、不同 store）。
远端视图必须有：**设备在线状态（最近心跳）**、**已配对设备列表 + 一键解除**、
`apiKey` 字段**只写不读**渲染为 `sk-****后4位`（A1）。

"哪些 bot 是我的"的判定：不在你已配对设备的 deck 里，就不是你的。
房间里的 `BOT·名` 徽章可伪造，沿用上一轮信任模型，**不引入签名防伪**（非目标）。

### 11.6 四条红线

1. **apiKey 永不进控制帧**（A1）；面板只做只写不读
2. **预算/限速取 `min(面板下发, daemon 本地硬上限)`**（A2）——刷屏事故责任否则落在中继
3. **daemon 侧指令白名单**（A3）+ `saigai-bot revoke --all` 在终端单方面踢掉所有已配对浏览器；
   **机器的所有者是终端，不是网页**
4. **配对码**：≥6 位随机、60s 过期、单次使用、尝试 5 次封 IP；**未知 token 一律回同一错误**
   （A7，无枚举预言机）

**隐私边界（须写进 RULES 页）**：中继看得见所有控制帧内容——人格文案、房间、开关、预算。
这属轻度隐私，设计判断为可接受；apiKey 与房间消息内容不经此路。真要端到端加密则是 v2 的
ECDH 配对（密钥交换 + 面板侧加密），代价是配对流程复杂一倍，**v1 不做**（§3）。

### 11.7 P3 交付判据

手机 4G（非家里 WiFi）上完成配对并改一个 bot 的 persona，daemon 侧热重载生效且**无掉线**；
同一 daemon 被 PC + 手机同时配对，两端状态视图一致；`revoke --all` 后 PC 端面板立即变灰；
现有 39 个服务端测试全绿 + 设备通道新增测试；**`npm run build` 绿**（A9）。

---

## 12. 成本与刹车（把上一轮欠的账写死在文档里）

"关标签即停"是浏览器模式免费送的一条保险丝，daemon 下它不存在：`rhythm` 的
冷场 3–8 分钟自发发起 × 每小时 30 条软上限 ≈ 单 bot 720 条/天的理论上限，
深夜空房间的自我对话在烧真钱。因此：

- `limits.quietHours`（本地配置、面板不可放宽）：静默窗内**不调 LLM**、不主动发起，
  被 @ 仍可回（三层睡眠的"睡觉"态，§10.2）
- `limits.globalHourlyMessages`：跨 bot 的全局闸，先于单 bot 预算触发
- **刚上线静默窗**：daemon 冷启动/唤醒后 N 分钟内不做闲置发起（否则笔记本一开盖就往群里扔话题）
- 面板与 `status` 都要显示本小时消耗，**让花钱这件事在两处都看得见**

---

## 13. 阶段依赖、顺序、每步可停

| 阶段 | 内容 | 改服务端 | 依赖 | 完成后得到 |
|---|---|---|---|---|
| **P0** | 抽 `bot-core`、切 store.js、单实例锁 | ❌ | — | 一码两出口的能力 |
| **P4** | 拟人 spike + transcript 格式 + few-shot + 长度 + 分段连发 + 读空气 + 睡眠 | ❌ | P0 | **当前每日体感痛点的解药**，浏览器同步受益 |
| **P1** | `saigai-bot` CLI + 配置 + 热重载 + doctor + systemd | ❌ | P0 | PVE VM 今晚 24/7 常驻 |
| **P2** | Docker/NAS + npm + 部署文档 | ❌ | P1 | "所有人都能自己部署"成立 |
| **P3** | 设备连接类 + 配对 + 路由 + 面板双 deck | ✅ | P0+P1 | 手机上改配置、多设备接管 |

**顺序是设计者裁定（用户可推翻）**：P4 与 daemon 三条线正交、收益是用户当下最难受的那个、
且必须站在 P0 之上才能同时喂两条腿；P1 不抢，用户自己那台 VM 晚一周上线没有任何损失。

---

## 14. 留给 builder 的决定（不必回头问）

- 热重载 watcher 用 `fs.watch` 还是自带轮询（NAS/SMB 挂载下 `fs.watch` 可能失灵——**建议两者都做，
  默认轮询 2s，`--watch=fswatch` 可切**）
- `deck.js` 与浏览器 `store.js` 的具体切分边界、组件适配层写法
- 帧协议字段名、服务器路由表数据结构与内存回收（设备掉线后多久清 name 登记）
- `doctor` 的连通性判据与超时（§5 那条前提）
- Docker 基础镜像与多架构构建方式
- 多 daemon 场景：`deviceId` 生成方式（建议 = token 的 SHA-256 前 8 位，服务器无需存 token 明文）

## 15. 设计者裁定项清单（请用户核对，这些是我替你定的）

1. **顺序 P0→P4→P1→P2→P3**（用户上轮"不错"，未明确认可顺序本身）
2. **浏览器模式不退役**，与 daemon 并存为两条腿
3. **配对/中继（P3）排在最后**，P1 阶段"手机改配置"靠 SSH+vim+热重载
4. **配置文件用 ESM `.js`**，不用 TOML/JSON（理由：零依赖 + 多行文案）
5. **不做**服务端代管、不做多租户容器编排、不做账号体系（用户明确否掉代管）
6. **控制帧不端到端加密**（v2 可选），代价是站方看得见人格文案
7. **命名**：`saigai-bot`（用户定）+ `kuoluosaigai-bot-core`/`-daemon`（我按仓库习惯补）
8. **daemon 不落盘聊天记录**，缓冲纯内存、重启靠 P2P 重建（与浏览器语义对齐）
9. **`quietHours`/全局闸做成 daemon 必做**，作为常驻模式的成本刹车
10. **P4 先 spike 后改码**（四变体盲评），spike 不进主线

## 16.5 预扫描裁定（builder-check 12 问，10 项由设计者裁定）

**本节与前文冲突时，以本节为准。** fresh reviewer 读文档后提出的 12 个问题里，10 个是文档缺陷，
就地裁定如下；另外 2 个（Q5 apiKey 远程写入边界、Q6 P4 语料来源）留给用户拍板，见 §16.6。

| # | 缺陷 | 裁定 |
|---|---|---|
| Q1 | §8.1 的 `rooms: ['nebula']` 与 §11.4/白名单暗示"一 bot 多房"，但 core 是**一 bot=一连接=一房**（`normalizeCfg.roomId` 字符串、`switchRoom` 原子离开旧房、buffer/家族连击/闲置调度/≤10 条分/连接预算全按此假设） | **单房钉死**。§8.1 改 `room = "nebula"`；§11.4 dev-state 字段 `room`；白名单 `bot.enterRoom/bot.leaveRoom` 合并为 **`bot.switchRoom`**。多房 per bot 是重新架构 runner/deck 的另一个项目，不在本规划任何阶段 |
| Q2 | daemon 的可变状态（服务器分配的 `ANON-XXXX` 昵称、`lifetime` token 账）没地方放——配置是**用户手写的 ESM**，回写会毁注释并自触发 watcher 循环 | **旁挂状态文件** `state.json`（数据目录，与锁同级），载荷形状沿用 `kuoluosaigai:bots:v1` 的 `{version, providers(不含 apiKey), bots[{id,nick}], lifetime}`。规则：配置拥有**定义**，state 拥有**身份与账目**；启动时按 `id` 合并；热重载删除 bot → 保留 state 条目但打 ORPHAN 日志（防误删配置即丢身份），配置重新出现同名 id → 复用；daemon 永不写配置文件。`deck` 的 `storage` 端口在 daemon 侧就落到这个文件上 |
| Q3 | bot 的稳定身份键未定义，而热重载 diff 和 `bot.update` 都要按它寻址 | **`id` 必填**（配置里显式写 `id = "lixiao"`，`doctor` 校验唯一且 `[a-z0-9-]{1,32}`）。改名（`name` 变）= **变更**，连接与身份都不动；只有 `id` 增删才是增删。position-as-key 被否决（中间插一个 bot 会让后面所有持久状态集体错键） |
| Q4 | §11.3 自相矛盾：令牌谁铸造、未配对的 daemon 怎么 bootstrap、服务器是否要持久登记表 | 统一成一条链路：①daemon 首启**本地铸造** device token 并存数据目录（跨重启稳定）②未配对的 daemon 用**引导通道**连接（不带 token、只有 `pair-new` 能力，拿不到任何 deck 数据）③浏览器 `pair-claim(code)` → 服务器返回 `{deviceId, name, token}`（token 是 daemon 在 dev-auth 时上传的共享秘密，服务器**必然**持有它——见 §11.6 披露）④浏览器与 daemon 各自用该 token 走正式设备通道 ⑤服务器持久 `devices.json`（deviceId↔token 摘要 + 已配对会话列表），这是**新增的第二处落盘**，必须进 RULES 页 |
| Q7 | §7.3 的注入面清单已被 P0 计划的实际签名取代；且 core 的 runner **静默吞掉**非致命 `LlmError`（B8 决定，适合有人盯屏的浏览器），24/7 daemon 对 429 风暴/密钥退化/TLS 失败**零信号** | §7.3 以 P0 实际签名 `createDeck({storage, lease, reactiveImpl, getOwnerNick, wsUrl, rng, now, deps})` 为权威。**P0 端口冻结不动**（计划已在执行）；`onEvent('error'|'warn')` 事件端口作为 **P1 的第一个任务**加进 core（浏览器侧忽略即可，零行为变化）。否则 §8.2 的"结构化 stdout"没东西可记、§8.6 的验收抓不到"哑巴 bot" |
| Q8 | "配对尝试 5 次封 IP" 在 CF Tunnel 后面**不可实现**：源站看到的 `remoteAddress` 永远是 cloudflared 的地址 | 改为：限速键 = `CF-Connecting-IP`，**前提是源站端口不对公网开放**（列为 P3 的运维前置条件，写进部署文档）；不满足前提时退化为"按连接 + 码空间"限速，并在 RULES/文档里明说该退化形态的强度较低。封禁范围仅**配对端点**，不封整个连接 |
| Q9 | §12 `quietHours` 字面自相矛盾：静默窗内"不调 LLM"又"被 @ 仍可回"（回就得调） | 精确化：静默窗内**不主动发起、不接非点名的话**（这些一律不调 LLM，省钱生效）；**点名/@ 允许回**，但点名回复**同样计入 `globalHourlyMessages`**，全局闸满则静默不回（宁可显得没睡醒，不可烧穿额度）。实现放 **core** 的可选 `schedule` 输入（浏览器可选择不启用），避免 A8 分叉 |
| Q10 | G3"≤2s 收敛"与自己推荐的默认值算不出来（轮询 2s + debounce 1s，光检测就 ~3s） | 口径改为 **"检测后 ≤2s 完成收敛"**；检测延迟另计。默认值改：轮询 **1s** + debounce **500ms**，端到端最坏 ≈3.5s。§8.6 验收按"端到端 ≤3.5s"写 |
| Q11 | daemon 的 bot 没有"主人"：70% 档主人识别读 sessionStorage 的当次昵称，`getOwnerNick` 默认恒 null → 操作者本人被当 40% 档陌生人 | 配置加可选 `ownerNick`（值 = 操作者在站点上拿到的 ANON 昵称）。**并明写局限**：浏览器侧主人识别本就是会话级的（新标签页换昵称），所以这条在 daemon 侧同样只在"用户记得把昵称填进来"时生效；不做成必填，不引入身份验证 |
| Q12 | `status`/`pair`/`revoke` 怎么和**正在运行**的 daemon 进程说话没说；§8.6 的"status 数字与实际一致"需要新鲜度口径 | 数据目录里的 `rpc.json`（`{port, secret}`，`chmod 600`）+ 一次性 HTTP 控制服务只听 `127.0.0.1`。CLI 子命令读该文件后本地调用，带 secret。**Windows 也适用**（§8.5 已承诺支持，故排除 unix socket 独占方案）。`revoke --all` 走这条路让活进程立即轮换令牌；`status` 口径改为 **"≤5s 旧快照 + 附事件时间戳"**（周期快照做不到严格相等，验收随之改） |

### 16.6 留给用户的两问（阻塞 P3/P4 的范围，不阻塞 P0/P1/P2）

这两条不是代码问题，是**承诺**问题，所以不能由设计者代答。

**Q5 — 远端面板能不能改 API key？** 现文自相矛盾：A1 说"任何一帧都不许有完整 apiKey 流向站方服务器"，
而 §11.5 又要求远端 deck 的 key 只写不读、渲染成 `sk-****后4位`——显示后 4 位要 daemon 上报派生提示，
"写入"更意味着完整 key 走 浏览器→服务器→daemon，正面撞 A1 第一句。
- **(a) 推荐：key 永不进中继。** 改 key 只能 SSH/编辑配置文件；面板的 key 显示改为 daemon 主动上报的
  `keyHint`（后 4 位，由 daemon 决定要不要报、可随时关），"只写不读"退化为"面板只能看提示、完全不能写"。
  保住承诺，代价是手机上换 key 做不到。
- **(b) 面板可推 key。** 功能完整，但要重写 A1/红线 1/§11.6 隐私段，"服务器永不经手 key"这句公开承诺作废。

**Q6 — P4 的 spike 语料从哪来？** §10.4 要"同一段**真实**房间记录"跑四个 prompt 变体，而按设计
消息不落任何盘（服务器不存、daemon 不落、浏览器纯内存）。最省事的来源是写一个一次性旁观客户端蹲公共房、
把第三方消息倒到本地盘、再喂给外部 LLM API 四次——这是对站内其他用户的一次语料采集，
和 §3"不落盘"的非目标姿态直接相邻。**只有你能定**：允许采（多长/哪些房/要不要知会在 RULES 页加一句）、
还是你手工粘贴自己打的样本、还是用合成记录（后者会让 spike 的结论打折，因为拟人感恰恰长在真实语料上）。
P4 的范围在这一条有答案之前定不下来；P0/P1/P2 不受影响，继续执行。

## 16. 已知未决 / 风险

| 项 | 状态 |
|---|---|
| PVE VM 出网能否稳定连 DeepSeek/Kimi/OpenRouter | **未实测**，P1 `doctor` 的首要目标；不通则宿主 bot 只能锁定可达服务商 |
| CF Tunnel 对**长时间空闲** WS 的超时行为 | 未实测。参与者通道已有重连退避，但 daemon 夜间静默 + 心跳保活需一并验证（建议加 ping/pong） |
| 国内 AI 情感陪伴新规 + 生成内容标识要求 vs "坚决否认是 AI" | 合规边界不确定；P4 将其降为可选项，建议用户自行判断 |
| 上一轮 follow-up：`useChat.js` 侧 stale-socket 竞态未修 | 与本规划无关，可单开小 PR；core 抽取时会碰到，顺手评估 |
