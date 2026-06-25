# kuoluosaigai.com 首页设计 · 概念 A：Dollars 频道接入页

- 日期：2026-06-26
- 域名：kuoluosaigai.com（谐音"阔落塞该"）
- 定位：有记忆点的概念首页，聊天室作为可点击入口（v1 不接后端），下轮迭代接 WebSocket 做真聊天
- 技术取问：混合 = 自定义创意英雄区 + Ant Design（魔改主题）做结构化面板 + 随机主题切换
- v1 范围：纯静态，无后端、无真实聊天

## 1. 叙事体验

访客打开站点，像在"接入一个匿名频道"。页面经历约 3 秒开机序列：

1. 黑屏 → 终端日志逐行打印（打字机效果），示例：
   - `[BOOT] kuoluosaigai channel daemon v0.1`
   - `[OK] handshake`
   - `[FREQ] tuning to 7741...`
   - `[READY] press ENTER to join.`
2. 末行光标闪烁
3. 用户按回车 / 点击屏幕 → "接入"动画（一道扫描线扫过）→ 露出主界面

主界面中心是脉动的「进入聊天室」入口。v1 点击后弹出精致占位（"频道尚未开放 / coming soon"），不报错。背景持续低烈度动态：扫描线、噪点、偶现随机代号。

## 2. 视觉规格

- 底色：近黑 `#0a0e0a`（带极淡绿），非纯黑
- 主色：随频道频率变化（绿/青/品红/琥珀四选一随机），文字与辉光用主色
- 字体：英文等宽 JetBrains Mono / Fira Code；中文思源等宽或系统默认；标题等宽放大
- 动效：打字机、扫描线、辉光脉冲、噪点 overlay
- 尊重 `prefers-reduced-motion`：关动效时直接显示终态
- 整体：终端 + 都市传说张力，留黑、不花哨

## 3. 页面结构（单页）

```
App.vue
 ├─ BootSequence.vue      # 开机序列（打字机日志 + 光标）
 ├─ ChannelShell.vue      # 主界面外壳（背景动效、顶/底状态栏）
 │   ├─ 频道代号 + 频率显示（顶栏）
 │   ├─ CenterGate.vue    # 中央「进入聊天室」脉动入口
 │   └─ 状态栏（在线人数假值、时间、RESHUFFLE 按钮）
 └─ ChatPlaceholder.vue   # 点击入口后弹出的占位弹层（Ant Design Modal 魔改）
```

## 4. 随机主题 = 频道频率

每次访问随机抽一个频道，每个频道 = 一组 design token：

| 频率 | 代号前缀 | 主色 | 辉光 |
|---|---|---|---|
| 7741 | SETSUBUN | 终端绿 `#39ff14` | 绿 |
| 0313 | NEBULA | 青 `#22d3ee` | 青 |
| 0990 | MAGENTA | 品红 `#ff2d95` | 品红 |
| 1882 | AMBER | 琥珀 `#ffb000` | 琥珀 |

- 抽签在 `App.vue` 挂载时发生，写入 `sessionStorage`（同一会话刷新不跳变，关标签再开换新频）
- 代号 = 前缀 + 4 位随机数（如 `SETSUBUN-7741`），显示在顶栏
- 状态栏放 🔄 RESHUFFLE 按钮：手动换频（即"随机修改主题"交互）
- Ant Design 部分通过 `ConfigProvider :theme="{ token: { colorPrimary } }"` 跟随当前频道主色统一魔改

## 5. 技术架构

- 保留 Vue 3 脚手架（`vue-cli-service`、`src/main.js`、`public/`）
- 删除旧内容：`App.vue` 旧模板、`components/kuoluosaigai.vue`、`assets/logo.png`、`public/index.html` 旧标题
- 新增依赖：`ant-design-vue`（结构化弹层用，按需引入避免体积）；不新增动画库（纯 CSS + 少量 JS 打字机）
- 目录：
  ```
  src/
    theme/channels.js          # 4 个频道 token 定义 + 抽签逻辑
    composables/useTypewriter.js
    components/BootSequence.vue
    components/ChannelShell.vue
    components/CenterGate.vue
    components/ChatPlaceholder.vue
    styles/terminal.css        # 扫描线/噪点/辉光公共样式
    App.vue
    main.js
  ```
- 部署：`npm run build` 出静态包，任意静态托管；下轮接 WebSocket 时再上服务器
- `vue.config.js` 不动

## 6. v1 范围边界

明确不做：
- ❌ 真实聊天（WebSocket、消息持久化、多人广播）→ 下轮
- ❌ 后端、数据库、登录
- ❌ 移动端深度适配（基本可用，不极致）
- ❌ 多语言（先中文 + 英文终端文案）

做：
- ✅ 开机序列、主界面、随机频道、进入入口占位、RESHUFFLE

## 7. 错误处理 / 降级

- 移除旧代码 `axios` 调 `:8000/api/nothing`（v1 无网络请求）
- `prefers-reduced-motion` 时跳过开机动画直接显示主界面
- Ant Design 按需引入失败 / 懒加载兜底：占位弹层用原生 dialog 兜底（极简）

## 8. 测试

纯静态前端，重点测：
- 频道抽签逻辑（确定性单元测试，mock 随机数验证 4 频道轮转）
- 打字机序列顺序
- `prefers-reduced-motion` 分支
- 手测：4 频道视觉、RESHUFFLE、入口点击占位、移动端基本可用
