# 多聊天室（Multi-Room）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1 单全局房间升级为一期「房间=纯 ID」的多房间系统：抽签落地公共房、按 ID 加入/建房/切房、P2P 聊天记录重建、服务器唯一落盘是 ID 注册表。

**Architecture:** 服务器（Node+ws，零新依赖）只维护「ID 注册表（append-only 文件）+ 内存在线表」，消息按房路由并盖 `id/ts`；浏览器端三个纯模块（历史合并、LRU 缓存、房间列表存储）支撑升级后的 `useChat` 组合式，`ChatRoom` 顶栏 + 右侧抽屉 + 规则浮层构成 UI。

**Tech Stack:** Vue 3（vue-cli 构建、SFC）、vitest（客户端 jsdom / 服务端 node 双工程，根 `npm test` 聚合）、ws ^8、ant-design-vue 仅 ConfigProvider 主题。

**Spec:** `docs/superpowers/specs/2026-10-20-kuoluosaigai-multi-room-design.md`（必读，本计划所有数值以其 §7 为准）

## Global Constraints

- 不新增任何 npm 依赖（服务端仅 `ws`，客户端仅现有包）。
- 服务端 ESM（`server/package.json` 已是 `"type":"module"`）；客户端模块同现有风格（ESM + Vue 3）。
- 护栏常量（spec §7，全计划唯一定义处为 Task 2/3/5 的默认参数）：房间 ID `[a-z0-9]{6}`；人数 100；历史响应 200 条/份；历史窗口 2000 ms；客户端每房 500 条；LRU 20 房；发言 10 条/60s；消息 280 字；join 失败 10 次/60s；create 5 次/60s；counts 批量 50。
- 服务器绝不落盘消息内容；浏览器绝不把消息写入任何 storage。房间列表（仅 ID）允许进 localStorage，键名 `kuoluosaigai:rooms`。
- 公共房 ID 两侧镜像，字面量必须一致：`['setsubun', 'nebula', 'magenta', 'amber']`（server/rooms.js 与 src/theme/channels.js 各写一份）。
- 每个 Task 收尾时全量 `npm test` 绿才可提交；涉及协议变更的 Task 需同任务内修完旧测试的断言（Task 2、7 有明确说明）。
- commit message 沿用仓库风格：中文 conventional commits，结尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 测试命令：客户端 `npx vitest run tests/<name>.test.js`；服务端 `npm run test --workspace kuoluosaigai-server -- <name>.test.js`（vitest run 的过滤参数）。服务端涉及落盘的测试一律传 `roomsFile` 到 `fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-'))` 下的临时文件。

## Review Focus

spec 隐含但单任务测试未必自然覆盖、且真人最可能踩中的点（每条已指派到 owning task 的测试）：

1. **跨房污染**：用户在历史响应抵达前已切房——`history-res` 的 `roomId` 若与当前房不符必须丢弃，服务器侧也只在同房时投递（Task 3 服务器路由测试、Task 7 客户端守卫测试）。
2. **脚本枚举**：`join` 连续失败与高频 `create` 是探测仪/灌盘器——节流命中后回 `rate` 且不再执行副作用（Task 3）。
3. **浏览器缓存爆炸**：会话内逛过几十个房后，缓存恒 ≤20 房×500 条、当前房永不被淘汰（Task 5、Task 7 上限用例）。
4. **重启账本**：进程重启后旧房 ID 仍可进、注册表文件不重不漏（Task 1；Task 2 用同一 tmp 文件重启 server 验证）。
5. **断线重连回房**：掉线重连后自动回到断开前的房间并重新走历史窗口，昵称不变（Task 7）。

---

### Task 1: 服务端注册表模块（server/rooms.js）

**Files:**
- Create: `server/rooms.js`
- Test: `server/rooms.test.js`
- Modify: `.gitignore`（追加一行 `server/data/`）

**Interfaces:**
- Consumes: 无（独立模块）
- Produces:
  ```js
  export const PUBLIC_ROOM_IDS = ['setsubun', 'nebula', 'magenta', 'amber']
  export function genRoomId(rng = Math.random) // → 6 字符 [a-z0-9]
  export function createRegistry(file, { seed = PUBLIC_ROOM_IDS } = {})
  // 构造时：mkdir -p 文件所在目录、读行入 Set、seed 中缺失的行 append 进文件与 Set
  // 返回 { has(id): boolean, add(id): boolean /* 已存在→false 不落盘；新 ID→追加一行并 true */ }
  ```
  Task 2 的 `createServer` 用它做唯一落盘。

- [ ] **Step 1: 写失败测试** `server/rooms.test.js`（node 环境，用 `fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-'))` 造 tmp 文件）

```js
// 断言清单（各一个 it）：
// genRoomId() 匹配 /^[a-z0-9]{6}$/，连续 50 次无 throw 且至少出现两个不同值
// genRoomId(() => 0) 恒为 'aaaaaa'（字符表 'a' 开头 → 验证 rng 注入方式）
// 文件不存在 → createRegistry 后文件内容恰为 PUBLIC_ROOM_IDS 4 行
// has('nebula') === true；has('zzzzzz') === false
// add('abc123') → true，文件变 5 行；同 ID 再 add → false，文件仍 5 行
// 重新 createRegistry(同一文件) → has('abc123') === true（重启账本，Review Focus #4）
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm run test --workspace kuoluosaigai-server -- rooms.test.js`，Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现** `server/rooms.js`。字符表 `'abcdefghijklmnopqrstuvwxyz0123456789'`；`genRoomId` 每次 `CHARS[Math.floor(rng() * CHARS.length)]`；`createRegistry` 读文件按 `\n` 切行、`trim` 后非空即入 Set，append 用 `fs.appendFileSync(file, id + '\n')`（同步足够：仅建房时写一行）。
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2，Expected: PASS
- [ ] **Step 5: 提交** — `git add server/rooms.js server/rooms.test.js .gitignore && git commit -m "feat(server): 房间 ID 注册表 append-only 落盘模块"`

### Task 2: 服务端多房间核心协议

**Files:**
- Modify: `server/index.js`（`createServer` 重构为按房路由；心跳/静态托管/nick 逻辑不动）
- Test: `server/index.test.js`（新增 rooms describe；**同步改写 v1 旧用例的断言**——旧测试假设连接即广播 presence/join，v2 改为 join 后才有房事件）

**Interfaces:**
- Consumes: Task 1 的 `createRegistry`、`genRoomId`、`PUBLIC_ROOM_IDS`
- Produces:
  ```js
  export function createServer(opts = {})
  // opts: { roomsFile = path.resolve('server/data/rooms.log')（受 KUO_ROOMS_FILE env 覆盖）,
  //         roomCap = 100, historyRespMax = 200, joinFailLimit = 10,
  //         createLimit = 5, countsBatchMax = 50 }
  // 返回 { start(port), close() } 不变
  ```
  帧语义（spec §4.2 的完整表，Task 3 在此基础上追加三种帧）：
  - 连接后仅发 `assign`；未入房收到 `message` → `{type:'error', msg:'not in room'}`。
  - `{type:'join', roomId}` → 成功：移出旧房（房内广播 `leave`+`presence`）、入新房，回 `{type:'joined', roomId, online, selfId}`，房内其他人收 `{type:'join'|'leave', roomId, nick, ts}` 与 `{type:'presence', roomId, online}`；`selfId` = 进程内自增整数连接号。未知 ID → `{type:'join-error', roomId, reason:'unknown'}`；满员 → `reason:'full'`（`roomCap` 判定）。
  - `{type:'create'}` → 发号直至 `!registry.has`，`registry.add`，随即按 join 流程进房：先 `{type:'created', roomId}` 再 `{type:'joined', ...}`。
  - `{type:'message', text, badge}` → 仅房内广播 `{type:'message', id, ts, roomId, nick, badge, text}`（发送者也收）；`id` = `bootToken + seq.toString(36)`，`bootToken` 为每次进程启动生成的 4 位随机 `[a-z0-9]`（防重启后新旧 id 相撞）。
  - 断连：从所在房移除并广播 `leave`+`presence`。

- [ ] **Step 1: 写失败测试** — 在 `server/index.test.js` 增 describe('multi-room')，复用现有 `connect/nextFrame/boot` 辅助（boot 改为可传 opts：`boot({ roomsFile: tmpFile, roomCap })`）。断言：
```js
// connect → 首帧仅 assign（无 presence）
// join 'nebula' → joined {roomId:'nebula', online:1, selfId:number}
// join 'zzzzzz' → join-error reason 'unknown'，且该连接仍可 join 成功别的房
// 两连接同入 'setsubun'：后入者的 joined.online=2；先入者收到 join 事件帧含 roomId
// A 房连接发 message → B 房连接收不到；A 房另一连接收到含 id(bootToken 前缀+base36)/ts/roomId 的 message
// 连接1 在 setsubun，再 join nebula → setsubun 的同伴收到 leave+presence{online:1}；joined 后消息只到 nebula 成员
// boot({roomCap:2}) 三人先后 join 'amber' → 第三人 join-error 'full'
// create → created+joined 帧，roomId 匹配 [a-z0-9]{6}；tmp roomsFile 尾行 === roomId
// 未 join 直接 message → error 'not in room'
// 同 roomsFile 重启 server（先 close 再 boot 同文件）→ 旧 create 出的 roomId 可 join（Review Focus #4）
```
同时把 v1 旧用例中 `presence on connect`、全局 `join/leave` 断言改写为入房后的按房断言（保留 nick 复用与限速、截断用例）。
- [ ] **Step 2: 跑测试确认失败** — `npm run test --workspace kuoluosaigai-server -- index.test.js`
- [ ] **Step 3: 实现** — 内部状态：`clients = Map<ws, {connId, nick, roomId, times, joinFails, creates}>`、`rooms = Map<roomId, Set<ws>>`、`registry = createRegistry(roomsFile)`。把现有 `broadcast(frame)` 改造为 `sendToRoom(roomId, frame, except)`；presence/join/leave 全部按房。限速窗口沿用 `times` 数组滑动法，新增 `joinFails`/`creates` 同构数组（Task 3 接线用，此任务先记录不判）。
- [ ] **Step 4: 跑测试确认通过**（全绿含改写后的 v1 用例）
- [ ] **Step 5: 提交** — `git commit -m "feat(server): 聊天后端升级多房间路由协议"`

### Task 3: 服务端历史中继、counts 与反脚本护栏

**Files:**
- Modify: `server/index.js`
- Test: `server/index.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 2 的帧处理骨架、`joinFails/creates` 计数、`historyRespMax` 等 opts
- Produces（对客户端承诺的语义，Task 7 依赖）:
  - `{type:'history-req'}` → 同房其他人收 `{type:'history-req', roomId, from: 请求者selfId}`；请求者不收（自己就是响应者）。
  - `{type:'history-res', roomId, to, messages}` → 服务器校验：发送者当前房 === `roomId` === 目标连接当前房，否则整帧丢弃；`messages` 截断为最后 `historyRespMax` 条；目标收 `{type:'history-res', roomId, from: 发送者selfId, messages}`。
  - `{type:'counts', roomIds}` → 取前 `countsBatchMax` 个；`{type:'counts', counts}`，注册表内 ID → 在线数（可 0），未知 ID 键缺席。
  - 护栏：60s 滑窗内 `reason:'unknown'` 失败 ≥ `joinFailLimit` → 其后所有 `join` 一律回 `{type:'rate'}` 不再探测；`create` ≥ `createLimit` → `{type:'rate'}` 且不落盘；`counts` 超出批量静默截断。

- [ ] **Step 1: 写失败测试** — 断言：
```js
// A 入 setsubun 发 history-req → 同房的 B 收到 {type:'history-req', roomId:'setsubun', from:A的selfId}；B 房外同伴 C 收不到
// B 发 history-res{roomId:'setsubun', to:A.selfId, messages:[...3条带 id/ts/roomId 的消息]} → A 收到且 from===B 的 selfId
// 跨房污染用例（Review Focus #1）：A 入 setsubun → A 切到 nebula → B（留在 setsubun）迟发 history-res{roomId:'setsubun', to:A.selfId} → A 收不到（服务器同房校验）
// historyRespMax=2 时 messages 截为最后 2 条
// counts{roomIds:['nebula','<已知私房>','zzzzzz']} → counts 含 'nebula':0 与私房在线数，不含未知键
// boot({joinFailLimit:2})：连续 2 次 unknown 后第 3 次 join（哪怕合法 ID）→ rate
// boot({createLimit:1})：第 2 次 create → rate，且 roomsFile 行数未增加
```
- [ ] **Step 2: 跑测试确认失败** — `npm run test --workspace kuoluosaigai-server -- index.test.js`
- [ ] **Step 3: 实现** — 在 message 处理器里补三种帧分支；`rate` 判定用 Task 2 已记录的两个滑窗数组；history-res 路由需要 `byConnId = Map<selfId, ws>`（connId 入房时登记，断连删除）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(server): P2P 历史中继、在线数批量与反脚本护栏"`

### Task 4: 客户端历史合并纯函数（src/chat/historyMerge.js）

**Files:**
- Create: `src/chat/historyMerge.js`
- Test: `tests/historyMerge.test.js`

**Interfaces:**
- Consumes: Task 2/3 定下的消息帧形状 `{ id, ts, roomId, nick, badge, text }`（`type:'message'`）
- Produces:
  ```js
  export function mergeHistory(existing, responses, { maxPerRoom = 500 } = {})
  // responses: Array<{ messages: Msg[] }>（各响应者的一份记录，已含同房保证）
  // 返回新数组：existing 全保留；按 spec §5.2 多数派规则并入；按 ts 升序（同 ts 按 id 字典序）；
  // 超过 maxPerRoom 丢最旧。纯函数，无副作用。
  ```

- [ ] **Step 1: 写失败测试** `tests/historyMerge.test.js`
```js
// 单响应者：全采纳（[e1] + [r1,r2] → e1,r1,r2 按 ts 排）
// 双响应者：仅 ≥2 佐证 id 保留（r1:{a,b} + r2:{b,c} → 只 b；e 里的 a/c 仍在——existing 不受否决）
// 同 id 不同内容（text 篡改）且跨响应者不一致 → 该 id 整个丢弃
// 同一响应者内部重复 id 只计 1 票
// 排序：ts 升序、同 ts 按 id 字典序
// maxPerRoom=3，合并后 5 条 → 保留最后 3 条（丢最旧）
// 空 responses → existing 原样（新数组引用）
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/historyMerge.test.js`
- [ ] **Step 3: 实现** — 算法要点：每响应者先房内按 id 去重（首见为准）；`votes: Map<id, 响应者数>`，`conflicts: Set<id>`（同 id 内容 JSON 不等即标记，内容比较字段 id/ts/nick/badge/text）；候选 = `votes≥2 且非 conflict`，或 `responses.length===1 时全量`；与 existing 合并按 id 去重（existing 优先）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 历史合并多数派纯函数"`

### Task 5: 客户端房间消息 LRU 缓存（src/chat/roomCache.js）

**Files:**
- Create: `src/chat/roomCache.js`
- Test: `tests/roomCache.test.js`

**Interfaces:**
- Consumes: 消息帧（同 Task 4 形状）
- Produces:
  ```js
  export function createRoomCache({ maxRooms = 20, maxPerRoom = 500 } = {})
  // → { get(roomId): Msg[], replace(roomId, msgs), append(roomId, msg),
  //     drop(roomId), touch(roomId) }
  // get 无缓存返回 []。所有写操作与 get/touch 刷新该房 MRU；
  // 新建房间超 maxRooms 时逐出 LRU，且刚被操作的房间（=MRU）永不成为被逐者。
  ```

- [ ] **Step 1: 写失败测试** `tests/roomCache.test.js`
```js
// append 后 get 含该条；replace 覆盖
// 每房上限：maxPerRoom=3，append 5 条 → 只剩最后 3（丢最旧）
// LRU：maxRooms=2 → 建 r1,r2，touch r1，append r3 → r2 被逐（get(r2)=[]），r1、r3 在（Review Focus #3）
// drop 只删指定房
// 返回的数组是拷贝或内部一致（append 后旧引用 get 再取可见——同一数组引用即可，写明不做深拷贝）
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/roomCache.test.js`
- [ ] **Step 3: 实现** — `Map` 天然是插入序，touch/写时 `map.delete` 再 `set` 即重排 MRU；淘汰取 `map.keys().next().value`。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 房间消息 LRU 内存缓存"`

### Task 6: 房间列表存储 + 频道 ID 映射

**Files:**
- Create: `src/chat/roomList.js`
- Modify: `src/theme/channels.js`（CHANNELS 各项加 `roomId`；新增导出）
- Test: `tests/roomList.test.js`、`tests/channels.test.js`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces:
  ```js
  // src/theme/channels.js 新增
  // CHANNELS: [{ ..., roomId: 'setsubun'|'nebula'|'magenta'|'amber' }]
  export const PUBLIC_ROOM_IDS = CHANNELS.map((c) => c.roomId)
  export function channelByRoomId(roomId) // → channel | null
  // src/chat/roomList.js
  export function loadRooms(storage = globalThis.localStorage)
  // → PUBLIC_ROOM_IDS 恒在前 + 存储中其余（去重、过滤非法项）
  export function addRoom(roomId, storage = ...) // → 更新后列表
  export function removeRoom(roomId, storage = ...) // → 更新后列表；公共房 id 调用则拒绝移除原样返回
  // 存储键 'kuoluosaigai:rooms'，JSON 数组；storage 抛异常（隐私模式）→ 模块级内存数组兜底，本会话仍可用
  ```

- [ ] **Step 1: 写失败测试** — fake storage：`{ store:{}, getItem(k){...}, setItem(k,v){...} }`
```js
// loadRooms：空存储 → 恰为 PUBLIC_ROOM_IDS；存了 ['abc123','nebula'] → ['setsubun','nebula','magenta','amber','abc123']（公共在前+去重）
// addRoom('abc123') 后 storage 里的 JSON 含之；再 add 幂等
// removeRoom('nebula') → 列表不变（公共不可删）；removeRoom('abc123') → 删除
// getItem/setItem 全抛错的 storage → loadRooms/addRoom/removeRoom 不 throw，会话内列表仍增删
// channels：PUBLIC_ROOM_IDS === ['setsubun','nebula','magenta','amber']（与 server 字面量镜像，注释标明）；channelByRoomId('magenta') 返回 AMBER 前缀之外的 magenta 项；未知返回 null
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/roomList.test.js tests/channels.test.js`
- [ ] **Step 3: 实现** — 两个文件即可，无新依赖。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 房间列表本地存储与公共房 ID 映射"`

### Task 7: useChat v2 多房间协议 + ChatRoom 过渡适配

**Files:**
- Modify: `src/composables/useChat.js`（重写，保留 v1 的重连退避、nick 存取、resolveWsUrl 兼容、error 透出）
- Modify: `src/components/ChatRoom.vue`（仅改调用方式与顶栏房间名显示，抽屉/规则留给 Task 10）
- Test: `tests/useChat.test.js`（重写）、`tests/ChatRoom.test.js`（更新受影响断言：mount 即发 join）

**Interfaces:**
- Consumes: Task 2/3 协议帧、Task 4 `mergeHistory`、Task 5 `createRoomCache`、Task 6 `roomList`
- Produces（Task 8/10 依赖的完整形状）:
  ```js
  export function useChat(url, { badge = '' } = {})
  // → { status, error, nick,               // 同 v1
  //     currentRoom,   // ref<string|null>
  //     selfId,        // ref<number|null>
  //     messages,      // computed<Frame[]>：当前房消息缓存 ∪ 本会话瞬时系统帧(join/leave/rate)，ts 升序
  //     online,        // ref<number> 当前房在线数
  //     rooms,         // ref<string[]> roomList.loadRooms() 初始，join 成功后含新房
  //     counts,        // ref<Record<string, number>>
  //     joinNotice,    // ref<string>：'' = 无提示；'NO SUCH ROOM'|'ROOM FULL'|'SLOW DOWN'，5s 自动清回 ''
  //     connect(landingRoomId), disconnect, // connect 参：WS open 后 join 它（重连时优先断开前的 currentRoom）
  //     join(roomId), create(), send(text), refreshCounts(),
  //     removeRoom(roomId) // roomList.removeRoom + cache.drop（公共房 id 原样拒绝），同步 rooms ref
  ```
  关键行为：`joined` → 设 currentRoom/selfId/online、cache.touch、`addRoom`；`online > 1` 时发 `history-req` 并开 2000 ms 窗口收集 `history-res`（**逐帧校验 `roomId === currentRoom` 才入窗口**——Review Focus #1 客户端半）；窗口到点 `mergeHistory(cache.get(currentRoom), responses)` → `replace`。`message` 仅当 `roomId === currentRoom` 入缓存。`join-error` 按 reason 设 notice（'unknown'→NO SUCH ROOM、'full'→ROOM FULL、房相关 rate→SLOW DOWN）；`created` 记 roomId（后续 joined 统一处理）；`counts` 帧合入 counts ref；重连成功后自动 `join(断开前 currentRoom)`（Review Focus #5），nick 走现有 query param 机制不变。`refreshCounts(ids = rooms.value)` 发 `counts` 帧。

- [ ] **Step 1: 重写失败测试** `tests/useChat.test.js`（沿用 MockSocket/flush 辅助；定时器用例用 `vi.useFakeTimers`）——断言按上述 Produces 逐条覆盖，另加两条护栏专项：
```js
// 600 条 message 帧 → messages 视图长度 500（缓存上限贯通，Review Focus #3）
// 迟到的 history-res{roomId:'别的房'} → 窗口到点后视图不含其消息（Review Focus #1）
// close→重连（BACKOFF）后 send 的 join === 断开前房间；昵称 query param 保留
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/useChat.test.js`
- [ ] **Step 3: 实现 useChat v2**；随后改 ChatRoom.vue：`useChat(props.url, { badge: props.channel?.prefix || '' })`、`onMounted → chat.connect(props.channel?.roomId)`、顶栏左侧文案改 `● ROOM ${currentRoom ?? '--'}`、`online` 改绑当前房；sysText 增加对 `roomId` 字段容忍。同步更新 `tests/ChatRoom.test.js` 中「连接即 presence」类断言为「open 后发出 join 帧、joined 帧驱动 online」。
- [ ] **Step 4: 全量跑绿** — `npx vitest run`（客户端全 suite；此任务不改 server，根 `npm test` 应全绿）
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): useChat 升级多房间协议（切换/历史窗口/重连回房）"`

### Task 8: RoomDrawer.vue 房间抽屉

**Files:**
- Create: `src/components/RoomDrawer.vue`
- Test: `tests/RoomDrawer.test.js`

**Interfaces:**
- Consumes: Task 7 暴露的状态形状（作 props 传入）、Task 6 `PUBLIC_ROOM_IDS`/`channelByRoomId`
- Produces（Task 10 使用）:
  ```js
  props: { rooms: Array /* string[] */, current: String, counts: Object, notice: String /* ''|NO SUCH ROOM|... */ }
  emits: ['join' /* (roomId) */, 'create', 'remove' /* (roomId) */]
  // 结构：PUBLIC 区（公共房行：名称+色点+在线数，无删除钮）→ MY ROOMS 区（其余 id 行：在线数、⧉ 复制、✕ remove）
  // → notice 行（有值才渲染，终端风红/黄）→ 底部 [> id 输入 ⏎]（submit 即 emit join(trim 后值)）与 [+ NEW]（emit create）
  // 复制：navigator.clipboard.writeText(id)，缺失则 document.execCommand 兜底；按钮 1s 内显示 COPIED 防重复点击
  ```

- [ ] **Step 1: 写失败测试**
```js
// 渲染：rooms=PUBLIC_ROOM_IDS 时 4 行公共房名（SETSUBUN…）；counts={nebula:3} → nebula 行显 3，其余 '--'
// 私有行 'abc123'：有 ⧉ 与 ✕；✕ emit('remove','abc123')；点行 emit('join','abc123')；公共行无 ✕
// 输入 'zzzzzz' 提交 → emit('join','zzzzzz')，输入清空
// [+ NEW] click → emit('create')
// notice='NO SUCH ROOM' → 出现报错文案；'' 不渲染
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/RoomDrawer.test.js`
- [ ] **Step 3: 实现** — 终端风 scoped CSS（复用 ChatRoom 的边框/字体色值习惯），组件自包含无 store。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 房间抽屉组件"`

### Task 9: RulesModal.vue 规则浮层

**Files:**
- Create: `src/components/RulesModal.vue`
- Test: `tests/RulesModal.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `emits: ['close']`；文案常量导出 `export const RULES_SECTIONS`（组件内部，测试 import 校验内容）
  规则页大纲（spec §6 逐条落地，中英混排终端风）：房间=6 位 ID 永存不可删；无查询接口、ID 即门票；记录只活在在场者浏览器、P2P 同步、最后一人离开即永别；未知 ID 拒绝；护栏数值（100 人/200 条/500×20/10 条分/280 字/输错 10 次分/建房 5 间分）；防伪警告（多人交叉验证、单人无从对质、街头传闻）；删 rooms.log = 世界末日彩蛋。

- [ ] **Step 1: 写失败测试** — `RULES_SECTIONS` 含关键数值字符串（'100'、'200'、'NO SUCH ROOM' 语义句、'世界末日'）；渲染后逐节标题存在；✕ 按钮 click emit('close')。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/RulesModal.test.js`
- [ ] **Step 3: 实现** — fixed 全屏浮层 + scoped 终端风样式，内容静态。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 站内规则浮层（房间生命周期与数据原理）"`

### Task 10: ChatRoom 集成收尾（顶栏/抽屉/规则/Esc 优先级/色随房）

**Files:**
- Modify: `src/components/ChatRoom.vue`（顶栏按钮、抽屉与规则挂载、Esc 优先级、CSS 变量切色）
- Modify: `src/App.vue`（`closeChat()` 恢复 `--app-color/--app-glow` 为落地频道色）
- Test: `tests/ChatRoom.test.js`（追加集成用例）、`tests/App.test.js`（追加恢复色用例）

**Interfaces:**
- Consumes: Task 7 的 useChat 全量接口、Task 8 `RoomDrawer`、Task 9 `RulesModal`
- Produces: 无（终端集成）

- [ ] **Step 1: 写失败测试**
```js
// 顶栏：ROOM 指示（公共房显示 prefix+色、私房显示 id）；[ROOMS] 点击 → 抽屉渲染（RoomDrawer stub 存在）；[RULES] → RulesModal 渲染
// Esc 优先级：抽屉开着 → Esc 关抽屉聊天不关；规则开着 → 关规则；都关着 → emit close
// join 集成：抽屉 emit('join','abc123') → MockSocket 发出 {type:'join',roomId:'abc123'}；emit('create') → create 帧
// remove 集成：抽屉 emit('remove','abc123') → chat.rooms 不再含该 id、cache.get('abc123') 为空（Task 7 的 removeRoom 贯通）
// 色随房：joined 'nebula' → documentElement.style --app-color === '#22d3ee'；joined 私房 → '#39ff14'
// refreshCounts：抽屉打开时 MockSocket 收到 {type:'counts', roomIds:[...]}
// App.test：openChat→closeChat 后 --app-color 恢复为 channel.color
```
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/ChatRoom.test.js tests/App.test.js`
- [ ] **Step 3: 实现** — ChatRoom 局部状态 `drawerOpen/rulesOpen`；`joined` 监听里设 CSS 变量（公共房用 `channelByRoomId(...).color`，私房 `'--'` 重置回默认 `#39ff14`——用 `style.removeProperty` 让基础样式的默认绿生效）；抽屉打开触发 `chat.refreshCounts()`；`joinNotice` 直通抽屉 props。App 的 closeChat 里重设 `document.documentElement.style` 为当前 channel 色。
- [ ] **Step 4: 全量验证** — `npm test`（客户端+服务端全 suite）与 `npm run lint` 全绿；手动冒烟：`npm run build && npm start` 后开两个浏览器 tab，建房→复制 ID→另一个 tab 输入 ID 加入→互发数条→A 切房再切回→确认 B 的消息经历史合并仍在、未知 ID 显示 NO SUCH ROOM。
- [ ] **Step 5: 提交** — `git commit -m "feat(chat): 多房间 UI 集成（抽屉/规则/色随房/Esc 优先级）"`

---

## 收尾备忘（不属于任何 Task，执行者完成后汇报）

- 部署无新增步骤，但 `server/data/rooms.log` 须在 VPS 上可写且随代码目录持久（重启不丢=ID 永生的前提，spec §12）。
- 上 HTTPS 的既有事项（公司代理拦截明文 ws）与本功能正交，不受影响。
- spec deferred 项（ChannelShell 顶栏假在线数等）本轮不动。
