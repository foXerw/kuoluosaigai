# 接入动画补全设计 · kuoluosaigai v1.1

- 日期：2026-06-27
- 范围：补全 v1 记录的 spec 偏差——"按 Enter / 点击屏幕 → 扫描线扫过 → 露出主界面"
- 上游 spec：`docs/superpowers/specs/2026-06-26-kuoluosaigai-homepage-design.md`（第 1 节"叙事体验"第 3 步）
- v1 现状：仅有一个 `[ press ENTER to join ]` 按钮触发 `ready`，缺 Enter 键监听、缺点击屏幕、缺扫描线 wipe
- 不在本轮范围：真聊天室（下一轮独立 spec）、RESHUFFLE 复用 wipe

## 1. 触发方式

接入由两种输入触发，二选一即可：

- **Enter 键**：监听 `window` 的 `keydown`，`event.key === 'Enter'`；忽略带修饰符（Ctrl/Cmd/Shift/Alt）的组合，避免拦截浏览器快捷键。
- **点击任意处**：监听 `BootSequence` 根元素 `.boot` 的 `click`。

两者均调用 `BootSequence` 现有的 `emit('ready')`，App 侧无需区分来源。

仅当打字机序列 `done === true` 时才启用监听，避免开机途中误触。末行 `[ press ENTER to join ]` 文案保留为纯提示文本（不再是唯一可点按钮）。

## 2. 组件边界

新增 `src/components/ScanlineWipe.vue`——纯展示 + 自终止的覆盖层：

- 渲染一条自上而下扫过的扫描条，颜色取 `var(--app-color)`。
- 挂载即播放 CSS 动画，`animationend` 后 `emit('done')`。
- 不依赖 boot/shell 的内部状态，仅消费频道主色 CSS 变量。

改 `src/components/BootSequence.vue`：在 `mounted` 注册 Enter 键 + 根元素 click 监听，`beforeUnmount` 清理；`done` 为假时监听器为 no-op。末行提示文案降级为纯文本。

改 `src/App.vue`：相位由两态 `'boot' | 'shell'` 扩为三态 `'boot' | 'wiping' | 'shell'`。

## 3. 数据流 / 相位

```
BootSequence ──ready──▶ App: phase='wiping'
                          ├─ 挂载 ChannelShell（底层，opacity 0→1）
                          ├─ BootSequence 留挂载，opacity 1→0
                          └─ 挂载 ScanlineWipe（顶层 z-index）
ScanlineWipe ──done──▶ App: phase='shell'（卸载 boot + wipe，留 shell）
```

淡入淡出由 App 包装层 CSS class 驱动，transition 时长与扫描条动画共用常量 `WIPE_MS`，避免时间错配。`wiping` 态三层叠放：boot 层（淡出）→ shell 层（淡入）→ wipe 覆盖层（扫描条）。

## 4. 动效规格

- 扫描条：高 3px、`var(--app-color)` 实色 + 同色 `box-shadow` 辉光，`top: 0` → `top: 100%`，`ease-in`，**600ms**。
- 扫过期间：底层 boot `opacity 1→0`、shell `opacity 0→1`，与已批准 mockup B 一致。
- 色彩：扫描条与辉光均用当前频道主色（经 `--app-color`），随频道/RESHUFFLE 变化。
- 降级：`prefers-reduced-motion: reduce` 时，`ready` 直达 `phase='shell'`，不挂载 ScanlineWipe、无淡入淡出（与 v1 直接显终态策略一致）。

## 5. 测试（vitest）

新增 `tests/ScanlineWipe.test.js`：

- 挂载后断言扫描条 DOM 存在。
- 派发 `animationend` 后断言组件 emit 了 `done`。

扩展 `tests/BootSequence.test.js`：

- `done` 后派发 Enter 键 → 断言 `ready` 已 emit。
- `done` 后点击根元素 → 断言 `ready` 已 emit。
- 未 `done` 时派发 Enter → 断言未 emit。
- 修饰符组合的 Enter（如 Ctrl+Enter）→ 不触发。

扩展 `tests/App.test.js`：

- boot 阶段收到 `ready` → 相位进入 `wiping` 且 ScanlineWipe 已挂载。
- ScanlineWipe `done` → 相位进入 `shell` 且 BootSequence 已卸载、ScanlineWipe 已卸载。
- `reducedMotion=true` 时 `ready` → 直达 `shell`，ScanlineWipe 未挂载。

## 6. 范围边界

做：

- ✅ Enter + 点击任意处触发接入
- ✅ 自上而下扫描条 wipe（mockup B）
- ✅ 相位三态编排、淡入淡出与扫描条时长对齐
- ✅ `prefers-reduced-motion` 降级
- ✅ vitest 单测

不做：

- ❌ 真聊天室（WebSocket / 随机昵称）→ 下一轮独立 spec
- ❌ RESHUFFLE 复用 wipe 扫描效果
- ❌ "逐行 clip-path 帘幕揭示"效果（本轮用淡入淡出，与已批 mockup 一致）
