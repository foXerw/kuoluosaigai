# kuoluosaigai 个人 AI Bot（BOT DECK）设计

日期：2026-11-01
状态：builder-check 完成（3 问全部闭环：闲置发起、多标签互斥经用户拍板；预算口径由设计者裁定），待用户终审
前置：多房间轮 spec `2026-10-20-kuoluosaigai-multi-room-design.md`（本文档沿用其全部协议与护栏，**服务器零改动**）

## 1. 意图与动机

站点已有 P2P 历史重建 + 浏览器挂机保活的聊天室。用户希望利用个人 AI API token（免费/低价额度），
在房间里放置可自定义人格的 AI bot：单个或多个 bot 互相聊天（"电子斗蛐蛐"）、与真人互动，
且 bot 身份可区分、行为拟人、token 消耗可控可观。

核心洞察（用户提出，已验证）：bot 本质就是一个普通聊天室客户端——浏览器多开几条 WS 连接即可，
服务器一行不用改。P2P 历史重建天然解决"bot 进房先补上下文"。

## 2. 目标

- G1：用户在浏览器内配置 AI provider（OpenAI 兼容协议）与 bot 人格，启动后 bot 自主在房间聊天
- G2：拟人节奏——接话时机、延迟、冷场、AFK 都模拟真人（详见 §6）
- G3：多 bot（≤5）同场互聊且不死循环、不爆 token
- G4：独立 BOT DECK 管理面板：每 bot 状态/所在房间/token 用量/启停/切房/观战窗/清空会话缓冲
- G5：人机硬隔离——个人聊天身份与 bot 身份在连接、状态、存储三层完全分离
- G6：零服务器改动、零新增 npm 运行时依赖（AI 调用用原生 fetch）

## 3. 非目标

- 服务器侧 bot / 24 小时常驻（关标签页 = bot 消亡，这是本模型的天然边界）
- 页面刷新后自动重启 bot（防无人看守烧 token；刷新后等用户手动再启）
- 给 CORS 不通的 provider（智谱 GLM 等）做服务端转发代理
- 防伪：badge/nick 均可伪造，沿用现有信任模型，不引入签名机制
- typing 指示器、跨设备同步、bot 间私聊

## 4. 反目标（技术上跑通也算失败）

- A1：两 bot 互相触发无限对话，烧穿 token 或撞爆限速
- A2：bot 秒回、逢消息必回，一眼假
- A3：API key 泄漏到控制台日志、错误信息、或任何网络请求以外的地方
- A4：bot 状态混入人类的 roomCache/useChat，或反之
- A5：localStorage 占用失控（会话记录持久化、无界增长）
- A6：bot 违规被服务器限速/踢帧，扰乱同房真人体验

## 5. 约束

- 协议护栏全部沿用多房间轮：发言 ≤10 条/分/连接、单条 ≤280 字（服务器硬截断，客户端先自律）、
  join-error/rate 帧语义、房间 ≤100 人、history-res ≤200 条
- 昵称只能是 `ANON-XXXX`（服务器 NICK_RE），bot 人格名走 `badge` 字段（客户端自报、随 message 帧广播）
- Vue 3 + Ant Design Vue + vitest；测试基线 143 客户端 + 39 服务端，只增不减
- CORS 实测（2026-11-01，从用户家庭网络）：DeepSeek ✅、Kimi ✅、OpenRouter ✅；
  智谱 ❌、Groq/OpenAI/Anthropic 当前网络不可达。预设仅收录实测通过者，自定义 baseURL 不设限

## 6. 用户拍板的决定

1. **纯浏览器层**：bot 跑在用户标签页里，服务器零改动
2. **通用协议调用**：provider 配置为 OpenAI 兼容（baseURL + key + model），不绑死任何一家
3. **放飞模式生命周期**：bot 启动后独立于聊天室弹窗存活；Esc 关弹窗 bot 照聊；人类切房 bot 不跟随；
   面板手动停止或切房；关标签页全灭；刷新后不自动复活
4. **拟人节奏**（方向拍板，参数授权我定，见 §7）："和真人聊天接入时机类似"
5. **BOT DECK 管理面板**：看 bot 在哪个房间、token 用量、启停、切房、管理 bot 会话记录，
   浏览器内空间占用必须小
6. **人机隔离**：用户可切到 bot 所在房间，但身份仍是个人（无 badge 的 ANON），不是 bot
7. bot 会话记录**不持久化**：关浏览器即清空，重启靠 P2P 历史重建补上下文（我提议，用户确认）
8. **闲置发起**（builder-check Q1，用户拍板）：房内无人说话时 bot 要能主动开口/抛话题，
   保证"多 bot 互聊"不需要真人点火也成立；具体参数授权设计者定（见 §7）
9. **多标签轻量互斥**（builder-check Q2，用户拍板）：用心跳标记防同一 bot 在两个标签双开
   （双份 token 互相触发）；明确不选完整租约/TTL 清理系统

## 7. 我的决定（可推翻，均已在对话中回放确认）

- 接话概率默认值：点名 ~90% / 主人 ~70% / 其他真人 ~40% / 其他 bot ~20%，再乘人格「话痨度」系数（0~100 滑杆）
- 拟人延迟：思考 2~8s 随机 + 打字模拟（每 50 字 +1~2s，总封顶 15s）；发言前客户端自截 280 字
- 对话预算（防死循环）：房内 bot 连续发言 ≥6~10 条（随机阈值）→ 全体 bot 冷却 30~120s；
  钱包护栏：每 bot 每小时软上限 30 条，超限只回点名
- 随机 AFK：偶尔抽 5~20 分钟"不在"，期间只回点名
- 同一 bot 两条发言最小间隔 ≥8s（防消息风暴下并发触发排队轰炸）
- bot 上下文缓冲：每 bot 内存环形缓冲 ≤200 条（5 bot 满载 ~300KB 内存，零 localStorage）；
  喂 LLM 取最近 30~50 条
- token 用量：会话内计数（内存，刷新清零）+ 历史累计（localStorage 仅存数字）
- UI：ChannelShell 顶层独立 `BOT DECK` 入口开管理面板（不放 ChatRoom 抽屉——避免管 bot 必须先以个人身份进房，破坏隔离）
- badge 格式：`BOT·<人格名>`；人格名长度截断 ≤12 字符
- 主人识别：message 帧 `nick === 主人 nick`（sessionStorage 的 ANON 昵称，跨重连稳定）；可伪造，接受
- provider 预设：DeepSeek / Kimi / OpenRouter 三家 + 自定义；temperature 默认 0.9
- bot 上限 5 个
- AI 请求：30s 超时（AbortController）；429/5xx 重试一次；401/403 → bot 立即停用、卡片亮红报原因；
  空/畸形响应 → 丢弃本次发言机会（不重试不报错刷屏）
- 配置 schema 带版本号（`kuoluosaigai:bots:v1`），解析失败静默丢弃重建；localStorage 配额满 → 降级仅内存 + UI 提示
- 后台标签页 timer 节流：延迟回复可能迟到，接受并写入用户文档（WS 收发不受影响）
- **闲置发起参数**：房内静默后 3~8 分钟随机开窗；到点我方 bot 以随机顺序掷骰
  （基础 30% × 话痨度系数），首个通过者发起话题（system 附加"冷场破冰"指令），其余本 tick 不跟；
  发起成功后下一窗口放宽至 8~15 分钟（bot 自聊节奏自然放缓，控 token 下限）；
  房内任何消息（含自己的）重置窗口；AFK/冷却/小时预算/最小间隔照常约束发起
- **跨标签互斥参数**：每标签生成 tabId（crypto.randomUUID，仅内存）；运行中 bot 每 15s 向
  localStorage 租约 `kuoluosaigai:bots:lease`（botId → {tabId, ts}）写心跳；
  其他标签的 BOT DECK 打开时 + 收到 storage 事件时检查：租约新鲜（ts <60s）且非本标签 →
  该 bot 显示「在另一标签运行中」并禁用启动/停止（管理去运行它的标签）；
  ts ≥60s 视为死标签，允许接管；停止与 beforeunload 清除本标签租约；
  配置编辑不做互斥，维持 last-write-wins（互斥只保运行态）
- **对话预算口径**（builder-check Q3，设计者裁定）：家族连续发言计数**只认我方 bot**，
  以本机 botStore 中我方 bot 的 ANON nick 集合识别——不用 `BOT·` badge 字符串
  （badge 自报可伪造，否则陌生人刷假 badge 即可把我方 bot 永久压入冷却）；
  陌生人 bot 的消息不计预算，只按「其他 bot ~20%」低概率接话

## 8. 架构

```
App.vue
├─ ChatRoom.vue ── useChat()        ← 人类连接（现状不动）
│   └─ roomCache / historyMerge / roomList（现状不动）
└─ BotDeck.vue（新增，App 层常驻，keepAlive 语义：不随弹窗销毁）
    └─ botStore（新增 src/bots/store.js，Vue reactive 单例）
        ├─ providers: ProviderConfig[]     ← localStorage 持久化
        ├─ bots: BotInstance[]（≤5）        ← 配置持久化，运行时状态内存
        │   每个 BotInstance：
        │   ├─ BotConnection（src/bots/connection.js，纯 JS，非 composable）
        │   │   完整独立 WS 客户端：connect→assign→join→joined→收帧；
        │   │   参与 history-req/res（P2P 补上下文）；断线重连退避 1→2→5s；
        │   │   收 rate 帧 → 通知节奏引擎冷却翻倍
        │   ├─ ContextBuffer（环形 ≤200 条，观战窗数据源）
        │   ├─ RhythmEngine（§7 拟人节奏：概率/延迟/预算/AFK/间隔/闲置发起，纯函数可测）
        │   ├─ LlmClient（src/bots/llm.js，fetch OpenAI 兼容 chat/completions，读 usage）
        │   └─ UsageCounters（会话内存 + 累计 localStorage）
        ├─ tabLease（跨标签心跳互斥，§7：本标签 tabId + 租约读写 + storage 事件监听）
        └─ ownerNick（读 sessionStorage NICK_KEY；bot 认主人的唯一依据）
```

隔离保证（G5/A4）：BotConnection 不 import useChat/roomCache；bot 的房间缓冲与人类 roomCache
是两个互不引用的存储；BotDeck 面板不读人类聊天状态（除 ownerNick）。人类进入 bot 所在房间时，
双方只是同房的不同连接，online 数 +1 各算各的。

### 8.1 LLM 调用

```
POST {baseURL}/chat/completions
Authorization: Bearer {key}
{ model, temperature, messages: [
    { role:'system', content: 人格 prompt },
    ...ContextBuffer 最近 30~50 条映射为 user/assistant 轮次
      （bot 自己的历史发言 → assistant；其余人的 → user，前缀 nick+badge 以便区分说话人）
]}
```

解析 `choices[0].message.content`（trim、截 280）与 `usage.{prompt_tokens,completion_tokens}`。
流式（stream:true）非目标——回复本来就有人为延迟，无需首字加速。

### 8.2 人格 prompt 组装

性格描述（用户填，如"毒舌但心软的老程序员"）套固定模板，模板约束：
匿名终端聊天室语境、短句口语、≤280 字、禁 markdown/emoji 滥用、保持人设、
不知道自己是 AI 时如何回应（保持人设不承认）、冷场时可以主动换话题。
高级用户可勾选"直接编辑 system prompt"完全覆盖模板。模板文案留给 builder 起草，需过用户目测。

### 8.3 发言决策流（单条入站消息）

```
帧到达 → 是自己? 丢弃
       → 入 ContextBuffer（观战窗+上下文）
       → 节奏引擎判定：AFK 中？冷却中？小时预算耗尽？距上条 <8s？→ 任一命中则只记不回
       → 掷概率（对象类型 × 话痨度）→ 未中则只记不回
       → 排队（同 bot 串行，一次只处理一个发言机会；排队期间新消息只进缓冲不重复触发）
       → 延迟（思考+打字模拟）→ LlmClient → 成功则 join 房发言帧发出，失败按 §7 兜底
```

家族连续发言计数以 ContextBuffer 为准，但**只认我方家族**——按本机我方 bot 的 ANON nick 集合识别
（nick 由服务器分配，比自报的 `BOT·` badge 更难伪造）。家族任一成员发言推高全家族共享的预算计数，
确保多 bot 内部节奏受控；陌生人 bot 的消息不计预算，只按「其他 bot」低概率接话（§7 口径裁定）。

**闲置发起**（无消息驱动时的第二条入口）：房间静默计时器按 §7 窗口到点 →
我方 bot 随机顺序掷骰，首个通过者以「冷场破冰」附加指令调 LlmClient 主动发起话题
（走同一条排队/延迟/预算/间隔约束）→ 发出的消息同样计入家族连续计数——
若一直无真人接话，几轮后自然触发冷却衰减，不会无限自聊。

### 8.4 BOT DECK 面板（UI 细节留给 builder，信息架构定死）

- 入口：ChannelShell 顶层 `BOT DECK` 按钮，独立 modal，与聊天室弹窗互不嵌套（可同时开）
- PROVIDERS 区：预设三选/自定义 baseURL+key+model；key 输入 type=password，旁置明文警告
  （"token 只存本机浏览器，页面代码直连 AI 服务商"）
- bot 卡片：人格名+badge 预览 / 状态灯（running·stopped·error+原因）/ 启停开关 /
  当前房间 ID（可编辑切房）/ 本次会话 tokens（prompt+completion）与发言数 / 小时余量 /
  展开=观战窗（ContextBuffer 实时滚动，含"清空缓冲"钮）
- 新建 bot 表单：人格名（≤12 字）、性格描述、话痨度滑杆、provider+model 选择、temperature、
  初始房间 ID（默认=人类当前房或落地房）
- 终端风视觉沿用现有 chat 样式语言；具体布局/交互 builder 定

## 9. 边界清单（用户点名重点，实现与测试逐条对账）

**协议侧**
- B1 每 bot 完整走 assign→join→joined；joined 前不发言
- B2 参与 history-req/res：进房 online>1 时发 history-req，2s 窗口收集合并入 ContextBuffer（复用 mergeHistory 语义，但不写入人类 roomCache）
- B3 绝不回 `nick === 自己 nick` 的帧（防自激）
- B4 收 rate 帧 → 冷却翻倍退避，并计入错误计数（连续 3 次 → 停用亮红）
- B5 join-error unknown/full → 卡片报错，不无限重试（重试 3 次即停用）
- B6 发言前自截 280；空回复不发
- B7 切房 = 直接 join 新房（服务器原子处理 leave/join）；切房瞬间旧房在途 LLM 响应作废（校验当前房后才发）

**AI API 侧**
- B8 30s AbortController 超时；429/5xx 重试一次；401/403 停用亮红；畸形/空响应丢弃
- B9 key 只进 Authorization 头；console 日志、error.value、观战窗永不出现 key
- B10 并发控制：每 bot 同时最多 1 个在途 LLM 请求

**生命周期侧**
- B11 WS 断线 → 退避重连 → 成功后自动 rejoin 原房，节奏引擎状态保留、冷却重置
- B12 beforeunload → 全体 bot 断开（clean close）
- B13 刷新不自动重启；配置（含 provider/key/人格）从 localStorage 恢复，运行态归零
- B14 后台标签页 timer 节流 → 回复迟到属预期行为（文档写明）；WS 心跳依赖服务器现状，不加自定义 ping

**存储侧**
- B15 配置 schema `kuoluosaigai:bots:v1`；版本不符/JSON 损坏 → 丢弃重建，不炸 app
- B16 ContextBuffer/用量会话计数纯内存；localStorage 只存：providers、bot 配置、累计 tokens、（现有）nick/rooms
- B17 localStorage 写失败（配额/隐私模式）→ 降级仅内存 + 面板黄条提示，功能不中断

**隔离侧**
- B18 BotConnection/botStore 与 useChat/roomCache 零交叉 import（可用依赖检查测试固化）
- B19 人类进出房间、开关聊天室弹窗，对 bot 运行零影响（反之亦然）

**跨标签侧**
- B20 租约获取 = 读-改-写 + 短暂延迟后复查确认仍是本 tabId 持有（防两标签同时点启动的竞态）；
  接管死租约（ts ≥60s）前先清理残留；beforeunload/停止必清本标签租约；
  localStorage 不可用 → 互斥降级失效 + 面板黄条提示（同 B17 待遇，bot 功能不中断）
- B21 闲置发起受 AFK/冷却/小时预算/最小间隔全部约束；掷骰全员未过则本 tick 静默放弃
  （不发消息、不立即重试），下一窗口再掷；发起中的 LLM 请求在途时收到真人消息 → 照常完成发言
  （话题可能过时，可接受，不做取消）

## 10. 已知副作用（写入用户可见文档/规则弹窗）

- bot 计入房间 online 数，同房者看得到 `BOT·` badge——bot 是公开的，不伪装成真人
- badge/nick/主人身份均可伪造：别人也能挂 `BOT·` badge 或冒充你的 nick 骗取 bot 回复——沿用站点既有信任模型
- 多个用户各自带 bot 进同一房时，各家的对话预算只数自己家族、概率互相独立，
  房间可能变热闹——可接受（服务器 10 条/分/连接的限速仍是所有人的硬底线）

## 11. 测试策略（vitest，基线 182 只增不减）

- RhythmEngine 纯函数化：注入 RNG 与时钟，测概率分档/预算触发/AFK/最小间隔/小时上限/话痨度缩放
- ContextBuffer：环形淘汰、200 上限、prompt 窗口切片、说话人角色映射（自己→assistant）
- BotConnection：mock WS，测 assign→join→joined 时序、rate 退避、join-error 停用、断线重连 rejoin、history 窗口合并、B3 自帧丢弃、B7 切房在途响应作废
- LlmClient：mock fetch，测超时/429 重试/401 停用/畸形响应/usage 解析/截 280/B9 key 不外泄
- botStore：配置持久化 roundtrip、schema 损坏重建（B15）、配额降级（B17）、5 bot 上限、B18 依赖隔离
- 闲置发起：注入时钟+RNG，测窗口滚动与重置/随机顺序首个通过者发起/发起后窗口放宽/
  AFK·冷却·预算·间隔下不发起/全员未过则静默（B21）
- tabLease：mock localStorage+时钟，测心跳刷新/他标签新鲜租约禁启/死租约接管/
  获取竞态复查（B20）/unload 清理/存储不可用降级
- 家族计数：按我方 nick 集合识别，陌生人 `BOT·` badge 消息不推高预算（§7 口径）
- BotDeck 组件：卡片状态渲染、启停/切房操作、观战窗、key 输入不回显、「在另一标签运行中」态

## 12. 留给 builder 的决定

- 人格 prompt 模板具体文案（§8.2，需过用户目测）
- BotDeck/bot 卡片/新建表单的具体布局与交互细节（信息架构以 §8.4 为准）
- src/bots/ 内部文件划分粒度（store/connection/llm/rhythm/buffer 为最小拆分，可再分）
- 观战窗滚动/暂停交互
- bot 卡片错误文案的具体措辞（语义以 §9 为准）
- 是否在 RulesModal 增补 bot 相关说明条目（建议加，文案 builder 起草）
