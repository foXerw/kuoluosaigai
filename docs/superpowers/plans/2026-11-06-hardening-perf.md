# 硬化轮 + 性能优化计划

**Goal:** 清掉早先记档的正确性/滥用缺口，并用可复现基准测出服务端最贵的一条路径，做一项协议兼容的优化。

**Architecture:** 客户端（`useChat`/`historyMerge`）补 socket 同一性与输入校验；服务端补 badge 截断、crypto 随机源、全局建房闸、HTML no-cache；新增 `scripts/bench-server.mjs` 量化广播与历史响应扇出；服务端 `history-req` 只投给至多 `historyReplyCap`（默认 3）个同房成员，削减 O(N²) 历史风暴。

**Non-goals:** Redis/pub-sub 水平扩展（独立项目）、前端消息虚拟滚动、UI 改版、修改 P2P 历史合并语义。

## Design decisions（用户已授权直接开工，以下为 builder 裁定）

- 历史扇出上限默认 **3**：P2P 合并需要 ≥2 佐证；3 个响应者足够，继续放大只是 O(N²) 流量。客户端本来就能处理任意份数（1 份全量采纳、≥2 多数派）。
- 全局建房闸默认 **30 次/60s**（服务端级，区别于每连接 5 次）：防分布式脚本刷注册表。
- room ID / 匿名昵称 / 消息 id 前缀改用 `node:crypto.randomInt`；测试的 rng 注入保留。
- HTML（含 SPA 回退）`Cache-Control: no-cache`；带哈希的静态资源不加长缓存（保持现状，避免隐藏的陈旧问题）。
- badge 截断 32 字符；`history-res` 单份消息在客户端合并前截到 200 并过滤非对象。
- `useChat` 采用与 bot connection 同款的 socket 同一性守卫：旧 socket 的迟到事件不得影响新连接。
- 基准数字只作本机相对比较，写入 `docs/perf-baseline.md` 并注明硬件/Node 版本。

## Review Focus

1. **旧 socket 竞态**：connect→close→reconnect 时旧 onclose/onmessage 是否污染新连接。
2. **恶意 history 帧**：非数组/超长/含 null 条目不得让合并崩溃或撑爆内存。
3. **随机源**：默认路径不得再依赖 Math.random；注入 rng 的测试仍可用。
4. **全局建房闸**：不能误伤正常单连接建房；限速响应与既有 rate 帧一致。
5. **历史扇出上限**：不影响单/双人房历史；≥2 响应者的多数派语义仍成立；上限可配置。

## Task 1: 客户端硬化（useChat + mergeHistory）

- [ ] 测试：旧 socket 迟到 close 不清空新连接；history-res 非数组/超长/含 null 被清洗；mergeHistory 跳过畸形条目。
- [ ] 实现；测试绿；提交 `fix(chat): useChat socket 同一性与 history 帧清洗`。

## Task 2: 服务端硬化

- [ ] 测试：badge >32 截断；room/nick/boot id 使用 crypto 默认（注入 rng 兼容）；全局建房闸；index.html `Cache-Control: no-cache`。
- [ ] 实现；测试绿；提交 `fix(server): badge/随机源/全局建房闸/HTML 缓存头`。

## Task 3: 基准脚本与基线

- [ ] 新建 `scripts/bench-server.mjs`（临时 rooms/devices 文件、广播 p50/p95、历史风暴耗时/字节）+ `npm run bench:server`。
- [ ] 跑 `historyReplyCap=1000`（基线）与 `=3`（优化）两组，写入 `docs/perf-baseline.md`。
- [ ] 提交 `perf(server): 可复现的广播/历史基准脚本`。

## Task 4: 历史响应急需扇出上限

- [ ] 测试：同房 5 人只有 3 人收到 history-req；双人房照常；cap=1 时请求者仍能拿到 1 份。
- [ ] 实现 `historyReplyCap` 选项；测试绿；用基准复测并记录 before/after。
- [ ] 提交 `perf(server): history-req 扇出上限`。

## Task 5: 文档、门、独立审查

- [ ] 更新 README（bench 命令、硬化项）；spec/RULES 无需改（无用户可见语义变化）。
- [ ] `npm test` / build / lint；opus 审查 + 修复。
