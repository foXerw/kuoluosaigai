# saigai-bot daemon：systemd 常驻部署与运行语义（P1，spec §8.4/§8.5）

这份文档是「把 daemon 挂到 VM 上过夜」的操作面。它最重要的职责不是安装步骤——而是
**把十类「看起来像 bug、实际是决策」的行为说清楚**，免得值班的人和报障的人隔空吵架。
每条都注明代码出处；文档与代码冲突时，以代码为准并请回报修文档。

---

## 1. 安装（Linux VM）

```bash
# ① 装包（saigai-bot 进 PATH；engines: Node ≥ 22，裁定 D1 用原生 WebSocket、零运行时依赖）
npm install -g ./packages/bot-daemon

# ② unit 就位
sudo cp packages/bot-daemon/deploy/saigai-bot.service /etc/systemd/system/

# ③ 语法验证——开发机没有 systemd，这一步只能在 VM 上做，别跳过：
systemd-analyze verify /etc/systemd/system/saigai-bot.service

# ④ 数据目录与配置（首次启动前就位，见 §2）
sudo install -d -m 700 /var/lib/saigai-bot/.config/saigai-bot
$EDITOR /var/lib/saigai-bot/.config/saigai-bot/saigai-bot.config.js

# ⑤ provider key（见 §3），然后启动
sudo systemctl daemon-reload
sudo systemctl enable --now saigai-bot
journalctl -fu saigai-bot

# ⑥ 观测
saigai-bot status
```

### 首次启动的两个硬前提

- **配置文件必须先存在**。`run` 对坏配置/缺配置一律拒起（退 1）；`Restart=always`
  下这表现为「每 5 秒重试一次的循环」——journal 里会有大声的 `FAIL: 配置读取失败
  （unreadable）`。这不是 daemon 疯了，是它拒绝带着坏配置裸奔（cli.js 启动序列②）。
- **`.js` 配置文件的 ESM 判定**：Node 按「最近的 package.json 的 `type`」决定 `.js`
  按 ESM 还是 CJS 解析。数据目录默认没有 package.json，`export default {…}` 会被当
  CJS 拒收（退 1）。最省事的解法是在数据目录放一份只写着
  `{ "type": "module" }` 的 `package.json`；或者改用 `.mjs` 文件名并在 unit 的
  ExecStart 追加 `--config <路径>`。

## 2. 数据目录与 unit 决策速览

默认数据目录 = `os.homedir()/.config/saigai-bot`；unit 用 `Environment=HOME=/var/lib/saigai-bot`
把它钉到 `/var/lib/saigai-bot/.config/saigai-bot/`（cli.js 的 `DEFAULT_DATA_SUBDIR` 与
`resolvePaths`）。里面住着：

| 文件 | 作用 | 出处 |
| --- | --- | --- |
| `saigai-bot.config.js` | 配置（ESM 纯数据 default export） | config.js、cli.js `DEFAULT_CONFIG_FILE` |
| `saigai-bot.lock` | 单实例锁（被占时 `run` 退 3，绝不双跑） | lock.js `DEFAULT_FILE_NAME` |
| `state.json` | 身份（nick）与 lifetime token 账；**永不带 apiKey** | state.js 文件头 |
| `rpc.json` | 控制面门牌 `{port,secret,pid,startedAt}`，随 daemon 生命周期出现/消失 | rpc.js |

§8.5 钉死的 unit 键（每条都是决策，tests/deploy.test.js 逐行钉住）：

| 键 | 值 | 理由 |
| --- | --- | --- |
| `Restart` / `RestartSec` | `always` / `5` | 24/7 常驻；崩溃与异常退出都拉回。想停请 `systemctl stop`，受管 stop 不触发重启。坏配置会 5s 一轮重试——先 `validate`/`doctor` 再 start。 |
| `After` (+`Wants`) | `network-online.target` | 连 WS、打 provider 是 §5 前提；`After` 只排序，`Wants` 才把目标拉进场。 |
| `MemoryMax` | `192M` | 内存越限 = cgroup OOM 硬杀 + 自动复活。症状是 journal 一声 Killed，不是慢腐。丢的只有内存态（见 §6.1/§6.2）。 |
| `DynamicUser` | `yes` | §8.5「非 root 专用身份」的实现：每次启动铸新 UID/GID，无驻留账号；数据属主由 `StateDirectory=saigai-bot` 自动对账。 |
| `ProtectSystem` | `strict` | 全盘只读；唯一写面 `ReadWritePaths=/var/lib/saigai-bot`（§8.5 点名要求显式声明）。 |
| `ExecStart` | `/usr/bin/env saigai-bot run` | env 走 PATH 解析；`run` 语义与退出码见下。 |

## 3. 密钥：永远不进配置文件

配置文件会被反复编辑、容易被备份/截图/git 误带走。key 的正确位置是**环境**：

```js
// saigai-bot.config.js
export default {
  name: 'vps-a',
  provider: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
              apiKey: process.env.KUO_LLM_KEY }, // 校验层永不回显 key 值
  bots: [ /* … */ ],
}
```

- unit 里有两条注入路径（选一条）：`EnvironmentFile=-/etc/saigai-bot/saigai-bot.env`
  （推荐，root:600，`-` = 缺文件不报错）；或注释示例 `Environment=KUO_LLM_KEY=sk-…`
  （代价：key 进 unit 文件与 `systemctl show` 可见）。
- 热重载每轮**真重导入**配置文件、重读 env（watch.js 文件头「缓存击穿重导入」），
  所以在 EnvironmentFile 里换 key → 保存该文件 → 让配置有一次真实内容变化（或重启
  进程），换 key 即生效；provider 变更对在跑 runner 的影响见 §6.5/§7。
- key 拿不到时**拒起不裸奔**：`apiKey` 为空/undefined 会校验失败退 1
  （config.js `provider.apiKey` 条目）。
- 落盘与输出面：`state.json` 由适配器剥掉 `apiKey`（state.js 文件头）；日志器对键名
  命中 `/key|token|secret/i` 的值遮成 `sk-****后4位`，并对**已知 key 值**做全文替换
  （log.js 双策略脱敏）；`status` 输出零 secret、零 key 材料（rpc.js）。

## 4. 退出码约定（cli.js `EXIT_*`）

| 码 | 含义 | 值班动作 |
| --- | --- | --- |
| `0` | 正常停止（收到信号且关停四步全干净） | 无 |
| `1` | 校验/体检/启动失败；`status` 查不到 daemon | 看 stderr 的分型文案（配置 kind、锁检查炸、boot 失败） |
| `2` | 用法错误（子命令/参数不对） | 多半是 unit 的 ExecStart 写错了 |
| `3` | 单实例锁被占（**绝不双跑**，A5） | `systemctl status` 看是否已有实例；文案带持有者 PID |
| `4` | **关停有步骤失败**（裁定 R34） | 见下 |

**R34——为什么 4 单独成码**：关停按钉死顺序 `watcher.stop → control.close → host.shutdown
→ lock.release` 执行（cli.js `shutdownParts`），每步独立 try/catch、一步炸不连累后两步，
但任何一步炸都会让退出码变 4。要紧的是 `host.shutdown`：它走 `deck.dispose()`，负责把
lifetime token 账**冲刷落盘**（deck.js 的 B12 最终 persist）——这一步炸意味着最近
10 秒节流窗内的 token 账可能没进 `state.json`，**成本账目丢失**。systemd 的
`Restart=always` 不在乎码是 0 还是 4，所以人（和脚本）只能靠退出码分辨「干净停止」与
「停止流程有失败」；journal 里对应的是 `FAIL: 关停步骤失败（…）` 行与
「这不是干净停止（R34）」结语。反复出 4 → 查数据目录可写性与磁盘。

## 5. doctor：回答 §5 那条**从未实测**的前提

计划里「VPS 出网能稳定连到 LLM provider」一直没被实测过（此前的 CORS 数据来自家庭
网络，不能推定 VM 同样可达，spec §5/§16）。`saigai-bot doctor` 的存在就是给它一个
可执行的答案：**FAIL 是真答案，不是事故**——查出来连不通，正好在烧真钱之前改方向。
任何一项 FAIL 都退 1；输出逐行 `OK`/`FAIL [n/7]`，判不出来时宁可 FAIL、绝不耸肩式
OK（doctor.js 文件头）。

| 检查 | 测什么 | FAIL 时怎么办 |
| --- | --- | --- |
| 1 Node 版本 | `process.versions.node ≥ 22` | 升级 Node；不满足则 P1 连接形态不成立（R5/D1） |
| 2 原生 WebSocket | `globalThis.WebSocket` 在场 | 装 Node ≥22（禁 `ws` 包，裁定 D1） |
| 3 配置校验 | 加载 + `validateConfig`（不连网） | 逐条 errors 修配置。**注意连锁**：本项 FAIL 时 4/5/6 会打「未实测」——那是没有参数可测，不是第三、四个故障 |
| 4 provider 连通性 | **真发一次最小 chat 请求**（会花极少量 token） | 按分型文案分流：`鉴权失败`=key 的事，换 key；`被限流或配额耗尽`=429/额度，别去换 key；`服务商 5xx`=对面没接住，稍后重试；`请求超时`/`网络层失败`=出网被墙/DNS/TLS——这条正撞 §5 前提：本 VM 到该 provider 的路不通或不稳，换出口/换 provider/改方向；`响应畸形`=baseUrl 指向的不是 OpenAI 兼容端点 |
| 5 serverUrl WS 可达 | 裸 `new WebSocket(url)`：open 即 close（R5） | 只测 TCP/TLS/握手层可达性——**OK ≠ 协议兼容/聊天健康**，FAIL ≠ 一定不是本 bot 的锅；处置方向是网络与 serverUrl 本身，不是协议细节 |
| 6 本地时钟 | 借 provider HTTP `Date` 头，阈值 300s | FAIL：查 VM 的 NTP（快照复活/无 NTP 的 VPS 是重灾区）。静默窗与小时闸吃的就是墙钟，偏移大 = 刹车时点错 |
| 7 数据目录可写 | mkdir + 写删探针文件 | 检查 unit 的 `StateDirectory`/`ReadWritePaths`、属主与磁盘 |

## 6. 看起来像 bug、其实是决策的十条（§8.4 与裁定）

### 6.1 会话缓冲纯内存，重启即清（§8.4）
每个 bot 的对话上下文缓冲（`createContextBuffer`，runner.js）与本次会话 token 计数
（runner.js `session`）**只在内存**，deck 落盘载荷里没有它们（deck.js `persist()` 只写
providers/bots/lifetime）。重启后靠既有的 P2P 历史机制重建：入房后发 `history-req`、
把房内响应 `mergeHistory` 回缓冲（runner.js `openHistoryWindow`/B2）。这与浏览器版
「关掉标签页」语义**逐字相同——不是回归**。身份（nick）与 lifetime 账目不受牵连，
它们在 `state.json`。

### 6.2 小时计数不跨重启（§8.4）
全局小时闸（`createHourAccountor`，schedule.js——闭包变量 `n`/`hourStart`）与每 bot 的
rhythm 小时计数都是内存态，落盘载荷里没有。重启把「本小时已用」清零：最坏情况同一个
钟点小时可被花到约两倍预算。这是**刻意取舍**（持久化逐条计数 vs 接受小时级回弹），
别把它报成「限流失效」；预算是刹车不是电表，方向是保守的。

### 6.3 热重载失败后，**watcher 不重试同样内容**（裁定 R31）
watcher 结算时先记账指纹再收敛（watch.js `settledFp`）；converge 抛错只复位稳定追踪，
**不动 settledFp**——之后每次轮询看到同一份内容都会命中「与已结算相同」分支静默跳过。
这是故意的：对一份确定性会失败的配置做收敛，重试风暴是更糟的替代。操作者要做的：
**先修根因，再保存一份内容真的有变化的配置**（指纹取 validateConfig 归一化后的内容——
改注释、调格式、`touch` 改 mtime 都不算数）；内容没法改或想要全新初始化，就
`systemctl restart saigai-bot`。journal 里对应信号是同一条 `配置非法（…）：保留上一份
好配置，不停任何 bot` / `热重载收敛调用抛异常` 只出声一次后归于沉默——沉默不是恢复。

### 6.4 退 4 = 关停不干净（R34）
见 §4 的表与论证；它是给脚本和人看的约定，systemd 本身仍会照常重启。

### 6.5 limits / serverUrl 变更要**重启进程**才生效；`restartRequired` 是粘滞位（裁定 R26/R28）
小时闸与 wsUrl 在 deck 构造期冻进闭包、core 没有热重算口——热重载遇到这两类变更时
**一个 bot 连接都不碰**（A4），只如实记日志并置位。`host.converge` 返回的 Report 里
`restartRequired` 只描述当次（watch.js 只把它打进日志）；`status` 读的是
`snapshot().meta.restartRequired` **粘滞位**（host.js `pendingRestart`）——一旦置位，
后续再多次成功的收敛都不会把它洗掉，**只有进程重启归零**。`status` 输出把它顶在
第一行 `!!` 横幅（rpc.js `statusRender`）：看见横幅就去 `systemctl restart saigai-bot`，
在此之前 daemon 仍在旧闸/旧地址上跑，这是如实告知而非死锁。provider 变更另走一条线：
model 扇出全部存活 bot（下次各自启动生效），apiKey/baseUrl 是 runner 启动期快照
（`needsBotRestart`），同样不断线。

### 6.6 出静默窗后的「秒开口」与墙钟 DST（Task 2 parked，操作者可见）
静默窗内 deck 的全局 tick 直接跳过调度器（deck.js `onGlobalTick` 的 gate 前置判定：
不洗牌、不掷骰、rng 零消耗），调度器的「静默多久了」视野**在窗内冻结**——它记的是
`windowUntil` 这个墙钟时刻（rhythm.js `createIdleScheduler`）。出窗后第一班车发现
时限早已跨过，会把整段窗口视为一次超长静默、**可能立即掷骰发起**。是否真开口仍要过
rhythm 门禁与掷骰。这是设计方向（「宁显得没睡醒，不可烧穿额度」的镜像面：省下的窗
不补发、也不冻结惩罚）——别报成「窗口一关它就抢话」。
另外静默窗是**本机墙钟语义**（schedule.js `wallMinutes` 用 `getHours()/getMinutes()`）：
跨零点窗正确，但夏令时（DST）切换当日窗口的实际时长会 ±1 小时（春天少一小时、秋天多一小时）。
在意这个的操作者：VM 用 UTC 或接受该日漂移。

### 6.7 孤儿身份永久保留；手删**不会生效**（Q2 + Task 5 parked）
配置里删掉一个 bot，它的 `nick` 与 lifetime 账目进 `state.json` 的 `orphans`（state.js
`computeOrphans`；journal 有一条 `ORPHAN: bot <id> 已移出 deck` warn，host.js
`orphanWarn`）；写回同名 `id` 即复用身份（`reuseOrphanNick`，boot 与热重载同规格），
账目在快照里与孤儿旧段**求和**（host.js `snapshot`）。**没有自动 GC**。
运行中手改 `state.json` 删孤儿条目**删不掉**：适配器按内存缓存的上次落盘基准重播，
下一次写就复活（state.js `baseline`/`lastDoc`）。唯一正确姿势：
`systemctl stop saigai-bot` → 删除 `state.json`（等价 removeItem：身份与账目一并抹除）
或换一个新的 `--data-dir` → 再 start。`status` 输出的孤儿清单也写着同一条路径。

### 6.8 `meta.deviceId` 在 P1 恒为 `null`（裁定 R30）
字段在场是为 P3 预留的形状；配对/设备令牌（os.hostname 冒名会被否掉的理由见 host.js
注释）什么都没接。`status` 会明说「null（P1 事实：设备令牌尚未铸造）」。人类可读的
名字看配置里的 `name`（Q11/Q4 口径）。

### 6.9 `rpc.json` 的 0600 不是防线；回环 + secret 才是
`fs.chmodSync(rpc.json, 0o600)` 在 Windows 上是**尽力而为**（POSIX 位与 ACL 模型不合，
可能静默无效）；Linux 下同样没人拿文件权限当护栏。真防线两条，都在代码里钉死：
服务**只绑 127.0.0.1**（其余 host 直接 TypeError，rpc.js `LOOPBACK_HOSTS`——`localhost`
这个名字都不信，防 hosts 文件劫持）；每个请求必须带与 rpc.json 一致的 **secret**
（≥16 随机字节 hex，SHA-256 摘要 + timingSafeEqual 等时比较；缺与错共用同一 401 体）。
控制面只有一个只读 `GET /status`，没有指令通道。所以在 Windows 上开发机跑 daemon：
rpc.json 权限位难看对也别慌，去看 §6.10……它只影响谁能读门牌，不影响谁能读 status。

### 6.10 status 的新鲜度与失败分型（Q12）
`status` = 读 rpc.json → 带 secret 一次 `http://127.0.0.1:<port>/status` → 渲染。数据
年龄按快照 `generatedAt` 如实报「N 秒前」（口径 ≤5s，不宣称与实时相等；超窗会明说
超窗，怀疑时钟跳变/daemon 卡滞）。失败五连文案互不相同——「未在运行（rpc.json 不在）」/
「读不出」/「陈旧解不出」/「连不上」/「超时」/「401 secret 不匹配」——按文案处置即可，
不用猜退出码（都退 1）。陈旧 rpc.json（daemon 死过一次没摘牌）是正常演化，文案会教你删。

## 7. 日常操作卡

```bash
saigai-bot validate --config /var/lib/saigai-bot/.config/saigai-bot/saigai-bot.config.js
saigai-bot doctor  # 改环境/换 provider 后跑一遍
saigai-bot status  # 粘滞 restartRequired 横幅 + 各 bot 读数 + 孤儿清单
journalctl -fu saigai-bot          # 结构化日志：一行一 JSON（journald 友好，§8.2）
sudo systemctl restart saigai-bot  # 让 §6.5 的粘滞位落地；也解决 §6.3 的「改不动内容」
```

改配置 = 直接编辑数据目录里的 `saigai-bot.config.js`，watcher 轮询 1s + debounce 500ms，
检测后 ≤2s 收敛（端到端约 3.5s，watch.js 时序口径）。daemon **永不回写配置文件**——
注释与格式都是你的（Q2）。调试/CI 想跑一轮就退：`saigai-bot run --once`
（零残留句柄；`--once` 下控制面不启动，status 自然查不到它）。

## 8. P1 边界（别在这里找还没造的东西）

`pair`/`revoke` 不存在（P3）；设备身份未接（§6.8）；浏览器侧才有的本地 key 语义在
daemon 侧被落盘剥离取代（§3）；`limits` 未配置 = 不装刹车（合法，config.js/host.js
的「不传 schedule 键」语义）。unit 与本文档随包发布（package.json `files` 含 `deploy/`）。
