# kuoluosaigai

> 谐音"阔落塞该"。一个终端风的概念首页，致敬无头骑士异闻录里的 Dollars 匿名聊天室。

打开 `kuoluosaigai.com`，像在接入一个匿名频道：开机序列逐行打印日志，光标闪烁，进入后是一个黑底扫描线的主界面，随机分到一个频道（绿/青/品红/琥珀），代号 + 频率显示在顶栏。脉动的"进入聊天室"入口目前是占位弹层——下一轮接 WebSocket 后就是真能聊的匿名频道。

## 特性

- **开机序列**：打字机式终端日志 + 闪烁光标
- **4 个随机频道**：SETSUBUN(绿) / NEBULA(青) / MAGENTA(品红) / AMBER(琥珀)，sessionStorage 持久，刷新不跳变
- **随机主题切换**：状态栏 🔄 RESHUFFLE 一键换频，主色经 CSS 变量 + Ant Design ConfigProvider 全局注入
- **聊天室入口**：脉动按钮 → Ant Design Modal 占位（v1 不接后端）
- **降级**：尊重 `prefers-reduced-motion`，关动效直接显示终态

## 技术栈

Vue 3 + Ant Design Vue（魔改主题）+ Vitest。自定义创意做英雄区，Ant Design 做结构化面板。纯静态，无后端、无网络请求。

## 本地开发

```bash
npm install      # 装依赖
npm run serve    # 本地预览 http://localhost:8080
npm test         # 跑单元测试（vitest，18 个）
npm run build    # 生产构建，产物在 dist/
```

## 项目结构

```
src/
  theme/channels.js            # 4 频道定义 + 抽签/重抽/代号
  composables/useTypewriter.js # 打字机序列
  components/
    BootSequence.vue           # 开机序列
    ChannelShell.vue           # 主界面外壳（代号/状态栏/RESHUFFLE）
    CenterGate.vue             # 聊天室入口
    ChatPlaceholder.vue        # 占位弹层（Ant Design Modal）
  styles/terminal.css          # 扫描线/噪点/辉光/降级
  App.vue                      # 装配：抽频道/主题注入/相位切换
```

设计文档见 `docs/superpowers/specs/`，实现计划见 `docs/superpowers/plans/`。

## 路线图

- [x] v1：概念首页 + 聊天室入口占位（纯静态）
- [ ] v2：WebSocket 真匿名聊天室（随机昵称、无需登录）
- [ ] 接入动画：Enter 键 + 扫描线 wipe
