#!/usr/bin/env node
// saigai-bot CLI 入口（Task 9 填实 Task 4 的骨架）。
// lint/工程约束：packages/ 归 eslint 7 + babel——**不用顶层 await**；一律 async main().then，
// 退出码经 process.exitCode 传递（不用 process.exit，给 stdout/stderr 冲刷留出回合）。
// main() 永不该 reject（cli.js 各分支自带兜底），这里的 rejection 分支是最后防线：
// 出声 + 退 1，绝不静默（A5）。
import { main } from '../cli.js'

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    try {
      console.error('saigai-bot 未预期异常：' + (err && err.name ? err.name + '：' : '') + (err && err.message ? err.message : String(err)))
    } catch (e) {
      /* 连 stderr 都炸时只剩退出码 */
    }
    process.exitCode = 1
  },
)
