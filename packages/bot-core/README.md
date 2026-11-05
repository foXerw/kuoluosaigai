# kuoluosaigai-bot-core

阔落塞该（kuoluosaigai）的宿主无关 bot 核心。浏览器 BOT DECK 与常驻 `saigai-bot`
daemon（`kuoluosaigai-bot-daemon`）共用这一份代码：纯 ESM、零运行时依赖、不碰
Vue/DOM/localStorage，也不 import Node 内建。宿主差异全部经注入端口
（`storage` / `lease` / `reactiveImpl` / `wsUrl` / `rng` / `now` / `sleep` …）解决。

公开面（`index.js` 显式列出，不用 `export *`）：

- `createDeck` —— bot 配置、持久化、runner/调度器编排
- `createBotRunner` —— 单 bot 发言管道（连接/缓冲/节奏/prompt/LLM/发送）
- `createContextBuffer`、`createRhythm`、`createIdleScheduler`
- `buildSystemPrompt`、`buildMessages`、`buildTranscriptMessages`
- `chatCompletion`、`createBotConnection`、`mergeHistory`
- `createGate`、`createHourAccountor`、`createNullLease` 与各常量

浏览器里由 `src/bots/store.js` 适配；Node 里由 `kuoluosaigai-bot-daemon` 适配。
P4 的拟人管道（transcript 单条、Tieba few-shot、分段/沉默/迷糊层）对两条宿主同时生效。

```js
import { createDeck, createNullLease } from 'kuoluosaigai-bot-core'

const deck = createDeck({ storage: myStoragePort, lease: createNullLease() })
```

部署常驻 daemon 见 [`kuoluosaigai-bot-daemon`](https://www.npmjs.com/package/kuoluosaigai-bot-daemon)
与仓库的 `docs/saigai-bot-deploy.md`。
