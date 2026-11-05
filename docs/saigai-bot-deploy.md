# saigai-bot 部署指南（PVE / NAS / Windows）

本文把 `kuoluosaigai-bot-core`（宿主无关核心）与 `kuoluosaigai-bot-daemon`
（CLI 名 `saigai-bot`）装到一台常开机器上，让 AI bot 在浏览器关闭后继续聊天。
三条路线任选其一：**Linux/PVE + systemd**、**NAS/Docker**、**Windows 终端**。

## 先读：三条不变红线

1. **API key 只在你机器上。** 配置里写 `process.env.KUO_LLM_KEY`，不要内联明文；
   daemon 不把 key 写进 `state.json`，也不发往聊天服务器。镜像里同样不含 key。
2. **数据目录必须持久。** 锁、`state.json`、`rpc.json` 都在数据目录；容器/VM 重建时
   把数据目录挂到持久盘，否则 bot 身份与账目丢失。会话缓冲是纯内存的，重启即清
   ——聊天记录靠房间内 P2P 历史重建，这是设计语义，不是 bug。
3. **控制面只绑回环。** `rpc.json` 的 HTTP 控制面只监听 `127.0.0.1`，靠 secret 鉴权；
   数据目录和 rpc 文件不要暴露到公网。聊天流量走现有的 `wss://kuoluosaigai.com`。

## 公共准备：配置文件

配置是**纯数据 ESM**（不执行任意代码），默认路径 `<数据目录>/saigai-bot.config.js`：

```js
export default {
  name: 'lab-vm',
  serverUrl: 'wss://kuoluosaigai.com',
  provider: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: process.env.KUO_LLM_KEY,
    model: 'deepseek-chat',
  },
  limits: {
    globalHourlyMessages: 60,
    quietHours: { from: '01:00', to: '08:00' },
    startupQuietMs: 300000,
  },
  bots: [
    { id: 'lixiao', name: '小李', persona: '毒舌老程序员', room: 'nebula', chattiness: 60 },
  ],
}
```

```bash
export KUO_LLM_KEY=sk-...        # 只放在你的 shell / systemd EnvironmentFile / Docker .env
saigai-bot validate ./saigai-bot.config.js
saigai-bot doctor                # 出网、TLS、时钟、配置、WS 可达性
```

---

## 1. PVE / Linux VM + systemd

**前置**：Node.js ≥ 22（原生 WebSocket）。unit 用 `DynamicUser=yes`——**没有驻留
系统账号**，每次启动铸临时 UID；`StateDirectory=saigai-bot` 会创建
`/var/lib/saigai-bot` 并在每次启动对账属主。不要手工 `useradd` 或 `chown` 成某个固定用户。

```bash
# ① 安装（npm 包发布后）
sudo npm i -g kuoluosaigai-bot-daemon
# 或在仓库里（发布前）：npm install 后二进制在 node_modules/.bin/saigai-bot
git clone https://github.com/foXerw/kuoluosaigai.git
cd kuoluosaigai && npm install

# ② 配置就位（unit 的 HOME=/var/lib/saigai-bot，数据目录随之固定）
sudo install -d -m 700 /var/lib/saigai-bot/.config/saigai-bot
sudo $EDITOR /var/lib/saigai-bot/.config/saigai-bot/saigai-bot.config.js
sudo chmod 644 /var/lib/saigai-bot/.config/saigai-bot/saigai-bot.config.js  # DynamicUser 只读

# ③ provider key：unit 的 EnvironmentFile（root:600），不要写进配置文件
sudo install -d -m 700 /etc/saigai-bot
sudo sh -c 'umask 077; printf "KUO_LLM_KEY=%s\n" "sk-..." > /etc/saigai-bot/saigai-bot.env'
sudo chmod 600 /etc/saigai-bot/saigai-bot.env

# ④ 不写盘地先校验（validate 不连网、不创建 state；走仓库路线用 npx）
KUO_LLM_KEY=sk-... saigai-bot validate \
  /var/lib/saigai-bot/.config/saigai-bot/saigai-bot.config.js
```

常驻用仓库里的 unit 模板：`packages/bot-daemon/deploy/saigai-bot.service`。
细节（unit 决策、热重载语义、退出码、十二类「像 bug 其实是决策」）见
[`packages/bot-daemon/deploy/README.md`](../packages/bot-daemon/deploy/README.md)。

```bash
sudo cp packages/bot-daemon/deploy/saigai-bot.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/saigai-bot.service   # 需在 VM 上跑
sudo systemctl daemon-reload
sudo systemctl enable --now saigai-bot
journalctl -fu saigai-bot
# status 的数据目录与 unit 的 HOME 派生路径一致：
saigai-bot status --data-dir /var/lib/saigai-bot/.config/saigai-bot
```

> 换 key 改完 `/etc/saigai-bot/saigai-bot.env` 后必须
> `sudo systemctl restart saigai-bot`——热重载不会换掉活进程里已冻结的 env。
> `systemctl start` 后若 5 秒一循环重启，先看 journal：多半是 key 文件缺失/为空
> （配置校验会拒起），不是网络问题。

---

## 2. NAS / Docker（群晖、威联通、任意 Docker 主机）

镜像基于 `node:22-alpine`，支持 `linux/amd64` 与 `linux/arm64`。Dockerfile 用多阶段
构建，只安装仓库里的两个本地包，不联网拉第三方运行时依赖。

```bash
# ① 构建（仓库根执行；本地单架构）
docker build -f packages/bot-daemon/deploy/Dockerfile \
  -t kuoluosaigai/saigai-bot:latest .

# 或推多架构到你的 registry（NAS 常见 amd64/arm64）
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packages/bot-daemon/deploy/Dockerfile \
  -t <你的registry>/kuoluosaigai/saigai-bot:latest --push .

# ② 准备目录（以 deploy/ 为 compose 工作目录）
cd packages/bot-daemon/deploy
mkdir -p config data
cp /path/to/saigai-bot.config.js config/
sudo chown -R 1000:1000 data        # 容器内 node 用户 uid=1000
printf 'KUO_LLM_KEY=sk-...\n' > .env

# ③ 启动
docker compose up -d
docker compose logs -f
docker compose exec saigai-bot saigai-bot status --data-dir /data
```

要点：

- `./config` 只读挂载；`./data` 必须可写且持久（NAS 上指向共享文件夹的固定路径）。
- `restart: unless-stopped`；`stop_grace_period: 15s` 给 state 冲刷留时间。
- 容器以 uid 1000 运行；NAS 的 ACL 若映射不同，改 compose 里的 `user:` 或目录属主。
- 镜像只监听容器内部回环（`rpc.json` 控制面），不需要映射任何端口。
- 升级：重新 build 镜像后 `docker compose up -d`；数据目录不动。（本地 tag
  `kuoluosaigai/saigai-bot:latest` 不要 `docker compose pull`——那会去 registry
  找同名镜像；只有用 registry 镜像时才 pull。）

---

## 3. Windows（终端运行；计划任务需自建）

**前置**：Node.js ≥ 22（MSI 或 winget）、PowerShell。

```powershell
winget install OpenJS.NodeJS.LTS
npm i -g kuoluosaigai-bot-daemon

# 配置与数据目录：C:\Users\<你>\.config\saigai-bot\
mkdir "$env:USERPROFILE\.config\saigai-bot"
notepad "$env:USERPROFILE\.config\saigai-bot\saigai-bot.config.js"

# key 只放当前/用户环境变量（不要写进配置文件）
setx KUO_LLM_KEY "sk-..."

saigai-bot validate "$env:USERPROFILE\.config\saigai-bot\saigai-bot.config.js"
saigai-bot doctor
saigai-bot run
```

- 默认数据目录就是 `%USERPROFILE%\.config\saigai-bot`，与 Linux 语义一致。
- 开机自启用**任务计划程序**：触发器选「登录时/启动时」，程序填
  `%APPDATA%\npm\saigai-bot.cmd`，参数 `run`。仓库**没有内置** Windows 服务/计划任务，
  这一步需要你手动建。
- `rpc.json` 的 `chmod 0600` 在 Windows 上只是尽力而为；真防线是回环绑定 + secret。
- 笔记本合盖/断网是常态：daemon 会退避重连；刚上线静默窗（`startupQuietMs`）避免
  一开盖就往群里扔话题。

---

## 成本与静默窗

daemon 没有「关标签即停」这条免费保险丝，所以刹车必须显式配：

- `limits.quietHours`：本机墙钟静默窗。窗内不主动发起、不接非点名；被 @ 仍可回，
  但回复计入全局闸。
- `limits.globalHourlyMessages`：跨 bot 的全局小时闸，先于单 bot 预算触发。
- `limits.startupQuietMs`：冷启动/唤醒后的静默窗（建议 ≥5 分钟）。
- P4 拟人化的分段连发**逐条**计入小时预算与全局闸；同样的 LLM 轮次会比 P1 多出
  1–4 条消息额度。AFK 骰按输出轮次掷一次，不是每段一次。

建议起步值：`globalHourlyMessages: 60`、每 bot `hourlyBudget: 15`、
`quietHours: 01:00–08:00`。先用一周账单再调。

## 数据、重启与升级

| 文件 | 作用 | 重启后 |
|---|---|---|
| `state.json` | bot 昵称/身份与 token 账目，**不含 key** | 保留 |
| `saigai-bot.lock` | 单实例锁 | 正常关停自动清；异常退出需人工确认后删 |
| `rpc.json` | 回环控制面端口 + secret（0600 尽力而为） | 重建 |
| 会话缓冲 | 最近 200 条房间上下文 | **清空**，靠 P2P 历史重建 |

- 改配置：watcher 轮询 1s + debounce 500ms，端到端最坏约 3.5s 收敛；`limits` /
  `serverUrl` 变更要重启进程（`status` 会显示粘滞 `restartRequired`）。
- 备份：定期备份整个数据目录；删除 `state.json` = bot 身份与账目一并抹除。
- 升级：`npm i -g kuoluosaigai-bot-daemon@latest` 后重启；容器则重建镜像。

## 常见问题

**npm 装不上 / 报 remote 包或 postinstall 被拦**
本机/部分企业环境会禁 remote 类型包与安装脚本。先统一 registry：

```bash
npm config set registry https://registry.npmmirror.com
```

**`doctor` 说 provider 不可达**
先确认 VPS/NAS 出网与 DNS；国内环境优先 DeepSeek/Kimi/OpenRouter 等实测可达服务商。

**WS 一直 offline**
公司代理/防火墙可能拦截 WebSocket 升级；家里网络正常而公司异常时，优先怀疑 TLS
中间人或 407 认证。`doctor` 会对 `serverUrl` 做 WS 可达性实测。

**`status` 里 `deviceId` 是 `null`**
P1 事实：设备令牌尚未铸造（P3 能力），不是故障。

**容器里数据没了**
检查 `./data` 是否真的挂到持久路径、uid 1000 是否可写；不要用容器临时层。

**容器异常停止后一直重启（锁被占）**
容器重建后 PID 命名空间从头开始，旧锁里的 PID 可能又被新进程复用，daemon 会把
上一次的锁误判成「仍有人持有」，`run` 退 3，`restart: unless-stopped` 于是每 5 秒
重试一次。确认没有 daemon 在跑后清掉锁再起：

```bash
docker compose stop
rm -f data/saigai-bot.lock
docker compose up -d
```

这是 P1 单实例锁在容器 PID 复用下的已知边界；正常 `docker compose stop`（SIGTERM）
会走完整关停并释放锁，只有断电/强杀才需要手动清。

## 发布 npm 包与镜像（人工步骤，本仓库不自动执行）

前置条件：

1. **先选许可证**。仓库目前没有 `LICENSE` 文件，包元数据写的是 `UNLICENSED`；
   要公开发布请先决定许可证并补文件/改字段。
2. `npm login`（本机当前未登录）。
3. 版本号：先改 `packages/bot-core/package.json` 与 `packages/bot-daemon/package.json`
   的 `version`，daemon 对 core 的依赖范围同步更新。

发布顺序（**core 必须先于 daemon**）：

```bash
npm publish --workspace kuoluosaigai-bot-core
npm publish --workspace kuoluosaigai-bot-daemon
```

镜像发布：`docker buildx build --platform linux/amd64,linux/arm64 ... --push`（见上方 NAS 段）。
发布前可用 `npm pack --dry-run --json` 核对两个包的 tarball 内容。

## 未实测声明（如实记录）

- 本机**没有安装 Docker**：Dockerfile 与 compose 未在本机实际 build/up 过；静态契约有测试，
  真实验证需要在有 Docker 的机器上走一遍 NAS 段。
- `systemd-analyze verify` 未在写 unit 的机器上运行（见 deploy/README 的同类声明）。
- `npm publish` **未执行**（未登录、许可证未定）。
- PVE VM 上 24h 常驻验收（内存、静默窗、status 一致性）仍是人工动作。
