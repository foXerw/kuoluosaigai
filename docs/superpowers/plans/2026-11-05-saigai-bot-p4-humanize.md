# P4 拟人化实现计划（Tieba few-shot 版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bot-core` 的发言从「客服答话」变成「群友插话」：transcript 单条上下文、Tieba 真实短句 few-shot、目标长度、分段连发、沉默选项、语气杂质、迷糊层。

**Architecture:** 全部改动落在 `packages/bot-core` 与测试，服务端零改动。新增纯模块 `humanize.js`（抽样/截断/沉默/分段/语气）与只读数据 `humanize-corpus.js`；`prompt.js` 增补 few-shot 与 transcript 组装；`runner.js` 在 `humanize` 开启时走新管道；`deck.js` 默认开启并下传独立 `humanizeRng`，避免扰动 rhythm 的注入 rng 序列。

**Tech Stack:** 纯 ESM、零新增依赖、零 IO、无 Vue/DOM/`node:` 内建；vitest。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §10（P4）

## Global Constraints

- core 纯度（`tests/botIsolation.test.js` 把守）：不得 import Vue、浏览器全局、`node:` 内建；不得新增运行时依赖。
- 服务端 `server/` 零改动；部署模型不变（`npm install && npm run build && npm start`）。
- 旧行为必须可回退：`createBotRunner` 的 `humanize` 缺省 **false**（runner 单测的严格 rng 序列全部不变）；`createDeck` 的 `humanize` 缺省 **true**（浏览器与 daemon 真实宿主默认受益）。
- `humanizeRng` 必须是独立随机流：不得与 rhythm 的 `rng` 共用，否则既有逐值 rng 断言全崩。
- 质量门：`npm test`、`npm run build`、`npm run lint` 全绿。lint 必须覆盖 `packages/`.
- 真人语料只取公开 Tieba 语料库的短句（MIT 仓库 `exusiaiwei/supp-social-media-style-2023`），**不采集本站任何用户消息**；入库前人工筛选，禁止 URL/联系方式/长数字/PII/辱骂/政治色情暴力内容。
- 语料条目只做 few-shot 示例，不参与任何运行时网络请求。

## Review Focus

1. **模型输出沉默标记但被当成正常发言**：`[沉默]`、`（沉默）`、`沉默`、前后空白都必须识别为不发送、不记账。
2. **分段连发击穿服务器限速**：一条输出最多 4 段，且段间有延迟；`rate` 帧到达后中止剩余段，不继续硬发。
3. **分段后小时预算/全局闸漏记**：每条实际发送都必须 `noteSpoken()` + `sent:true` 事件；沉默与发送失败不得记账。
4. **模型无视目标长度**：输出必须二次截断到 `targetLen + 6` 以内，且不得截出半个代理对（emoji）。
5. **切房/停机发生在多段之间**：每段发送前必须复查 `started`、`roomEpoch`、当前房、`cooling`，不得把旧房内容的剩余段发进新房。

---

### Task 1: Tieba few-shot 语料模块

**Files:**
- Create: `packages/bot-core/humanize-corpus.js`
- Test: `tests/botHumanizeCorpus.test.js`

**Interfaces:**
- Produces: `FEW_SHOT_EXAMPLES: string[]`（40 条，去上下文、去 PII 的真实贴吧短句）、`FEW_SHOT_HEADER: string`（插入 system prompt 的说明）。

- [ ] **Step 1: 写失败测试**：断言数组长度 30–60、全为字符串、每条 2–32 个码点、无重复、无 `http|www|@|QQ|微信|群号|私信`、无连续 5 位数字、无换行；`FEW_SHOT_HEADER` 含「学语气」「不要照抄」。
- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/botHumanizeCorpus.test.js` → module not found。
- [ ] **Step 3: 写入语料**：文件头记录来源仓库 URL、抽样日期、筛选规则；导出 40 条人工筛选后的短句与 header。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): Tieba 真实短句 few-shot 语料模块（P4）`。

### Task 2: 纯拟人工具 `humanize.js`

**Files:**
- Create: `packages/bot-core/humanize.js`
- Test: `tests/botHumanize.test.js`

**Interfaces:**
- Produces:
  - `SILENCE_TOKEN = '[沉默]'`
  - `isSilence(text: unknown): boolean`
  - `sampleTargetLength(rng?: () => number): number`（2–30，中位 5–15）
  - `truncateToTarget(text: string, target: number, slack = 6): string`
  - `applyTone(text: string, rng?: () => number): string`
  - `splitSegments(text: string, max = 4): string[]`
  - `planReply(text: string, { rng, targetLen, allowSegments = true }): { silent: boolean, segments: string[] }`
  - `HUMANIZE_DEFAULTS`：`{ maxSegments:4, segmentGapMs:[350,1200], segmentProb:0.5, toneProb:0.08, drowsyThinkFactor:2, drowsyMaxTarget:8 }`

- [ ] **Step 1: 写失败测试**：覆盖沉默变体（`[沉默]` / `【沉默】` / `（沉默）` / `(沉默)` / `沉默` / 带空白；含「我不想沉默」不得误判）；长度分布四档边界；截断到 target+6 且按码点（emoji `😀` 不被劈开）；分段（`好。行！那就这样？` → 3；无标点 → 1；6 句 → 4；换行可拆）；语气（`。` 结尾可去、概率括号、不叠加已有括号）；`planReply` 沉默/不沉默/概率分段（注入 rng 固定）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：纯函数、无 IO；`Array.from` 计码点；`splitSegments` 保留标点、合并过短碎片、尾部并入最后一段。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): 拟人纯工具（目标长度/沉默/截断/分段/语气）`。

### Task 3: Prompt 组装（few-shot + transcript）

**Files:**
- Modify: `packages/bot-core/prompt.js`
- Test: `tests/botPrompt.test.js`（追加新 describe，旧用例不动）

**Interfaces:**
- Consumes: Task 1 的 `FEW_SHOT_EXAMPLES/FEW_SHOT_HEADER`；Task 2 的 `SILENCE_TOKEN`。
- Produces: `buildSystemPrompt({ name, persona, override, fewShot = true })`（override 原样返回，不注入）；`buildTranscript({ frames, selfNick, window = 40, targetLen, idle = false, drowsy = false }) => Array<{role, content}>`（首条 system 由调用方给？——签名改为 `buildTranscriptMessages({ system, frames, selfNick, window, targetLen, idle, drowsy })`）。

- [ ] **Step 1: 写失败测试**：新 system prompt 含 few-shot 头与至少一条样例、仍含原规则；`override` 逐字节不变且无样例；`fewShot:false` 无样例；transcript：他人连续消息压成**一条** user 消息（含 `[群聊记录` 头和 `NICK: text` 行）、self 连续消息为 assistant、顺序保持、window 生效、footer 含目标字数与 `[沉默]` 选项、idle 有冷场指令、drowsy 有迷糊/短句指令。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：`buildMessages` 保持旧语义（旧测试全绿）；transcript 按「self 连续段 → assistant / 他人连续段 → 一条 user」切分；footer 追加在最后一条 user 上，无他人消息时单独造 user。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): few-shot system prompt 与 transcript 单条上下文（P4）`。

### Task 4: Runner 接入（目标长度 / 沉默 / 语气 / 迷糊）

**Files:**
- Modify: `packages/bot-core/runner.js`
- Test: `tests/botRunner.test.js`（`makeRunner` 增 `humanize/humanizeRng` 透传；旧用例不传 → 行为不变）

**Interfaces:**
- Consumes: Task 2/3。
- Produces: `createBotRunner({ humanize = false, humanizeRng = Math.random, ... })`。
- `humanize` 开启时：每轮 sample target；transcript 组装；沉默不发送不记账；发送前 `applyTone`/截断；`gate?.quietNow()` 为真时 think ×2、target ≤8。

- [ ] **Step 1: 写失败测试**：LLM 返回 `[沉默]` → 无 send、hourCount 0、无 `sent` 活动、runner 仍 started；正常回复 → 发送内容无句尾 `。`（注入 rng）、prompt 为 transcript 单条且含目标字数；drowsy（gate.quietNow true + 点名）→ think sleep 翻倍、无分段。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：在 `runJob` 内按 `humanize` 分支；`thinkMs` 使用本地变量参与 15s 封顶；沉默直接 return；记账保持每发送一条一次。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): runner 拟人管道——silence/目标长度/语气/迷糊`。

### Task 5: Runner 分段连发

**Files:**
- Modify: `packages/bot-core/runner.js`
- Test: `tests/botRunner.test.js`

- [ ] **Step 1: 写失败测试**：LLM 返回 `好。行！那就这样？` + 强制分段 rng → 3 条 message 帧、段间 sleep 在 `[350,1200]`、hourCount=3、`sent` 活动 ×3、buffer 有 3 条 local 镜像且 id 唯一；第二段前 stop/switchRoom → 只发第一段；发送失败 → 后续段不发且不记账。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：段循环，每段前复查 `started/epoch/currentRoomId/cooling`；`noteSpoken()` 每段一次；`session.messages` 按实际发送条数累计；段间 `sleep(between(humanizeRng, segmentGapMs))`；`rate` 期间 `cooling=true` 时中止剩余段。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): 分段连发与逐条记账（P4）`。

### Task 6: Deck 默认开启 + 文档 + 全门 + 独立审查

**Files:**
- Modify: `packages/bot-core/deck.js`（`humanize = true` 选项；`makeRunnerOpts` 下传 `humanize` 与可选 `deps.humanizeRng`）
- Test: `tests/botDeckCore.test.js`（fake runner 捕获 opts：默认 `humanize===true`；`createDeck({humanize:false})` → false；注入 `deps.humanizeRng` 原样下传）
- Modify: `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §10（记录 Q6 用公开 Tieba 语料解决、实现范围与偏离——跳过四变体盲评）
- Modify: `README.md` 路线图（BOT DECK 拟人化条目）
- Maybe: `packages/bot-daemon/README.md`（daemon 默认受益一句话）

- [ ] **Step 1: 写失败测试**（deck opts）。
- [ ] **Step 2: 实现**。
- [ ] **Step 3: 文档更新**。
- [ ] **Step 4: 三道门**：`npm test`（全部 workspace）、`npm run build`、`npm run lint`。
- [ ] **Step 5: 独立审查**：fresh reviewer 审整条分支 diff；修复 Critical/Important；复审。
- [ ] **Step 6: 提交**：`feat(bots): P4 拟人化默认开启与文档收尾`。

---

## Self-Review 备注

- 覆盖 spec §10.2：transcript（T3）、长度（T2/T4）、分段（T5）、读空气沉默（T2/T4）、语气杂质（T2/T4）、攒消息（T3 自然解决）、睡眠/迷糊层（T4，复用 P1 quietHours/startupQuietMs）、few-shot（T1/T3）。长期记忆与破限明确不做（spec 原范围）。
- 未做：四变体盲评 spike（用户直接指定实现，spike 的结论价值被牺牲，文档记录偏离）。
- `buildMessages` 旧接口保留，避免动 P0/P1 的既有测试指纹。
