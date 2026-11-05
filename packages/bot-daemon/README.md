# kuoluosaigai-bot-daemon（`saigai-bot`）

把阔落塞该的 AI bot 从浏览器搬到常驻进程：一台 VM / NAS / 桌面机 24/7 挂着，
关掉浏览器也继续聊天。与浏览器 BOT DECK 共用 `kuoluosaigai-bot-core`，行为一致。

## 安装

```bash
npm i -g kuoluosaigai-bot-daemon
saigai-bot --help
```

本机 npm 若禁用了 remote 类型包或 postinstall（部分国内镜像/企业环境），先设置：

```bash
npm config set registry https://registry.npmmirror.com
```

## 配置

默认配置 `<数据目录>/saigai-bot.config.js`，默认数据目录 `~/.config/saigai-bot/`。
配置是**纯数据 ESM 文件**，API key 只从环境变量读：

```js
export default {
  serverUrl: 'wss://kuoluosaigai.com',
  provider: { baseUrl: 'https://api.deepseek.com', apiKey: process.env.KUO_LLM_KEY, model: 'deepseek-chat' },
  limits: { globalHourlyMessages: 60, quietHours: { from: '01:00', to: '08:00' } },
  bots: [
    { id: 'lixiao', name: '小李', persona: '毒舌老程序员', room: 'nebula', chattiness: 60 },
  ],
}
```

```bash
export KUO_LLM_KEY=sk-...        # 只存在你机器的环境里
saigai-bot validate ./saigai-bot.config.js
saigai-bot doctor                # 出网/TLS/时钟/配置/WS 实测
saigai-bot run --config ./saigai-bot.config.js --data-dir ./data
saigai-bot status --data-dir ./data
```

## 常驻部署

- Linux/PVE + systemd：`deploy/saigai-bot.service` 与 `deploy/README.md`
- Docker / NAS：`deploy/Dockerfile` + `deploy/compose.yaml`
- Windows：直接终端运行；计划任务需自行创建（未内置）

完整三路线说明见仓库 `docs/saigai-bot-deploy.md`。

## 边界（真实行为）

- 会话缓冲纯内存：重启即清，靠房间内 P2P 历史重建。
- 小时计数不跨重启持久；`quietHours` / `globalHourlyMessages` 是主要成本刹车。
- `rpc.json` 控制面只绑 `127.0.0.1`；不要把它或数据目录暴露到公网。
- API key 不会写进 `state.json`，也不会发往聊天服务器。
