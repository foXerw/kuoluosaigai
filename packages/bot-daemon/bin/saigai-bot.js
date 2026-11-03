#!/usr/bin/env node
// saigai-bot CLI 占位入口（Task 4 只建骨架；run/validate/doctor 子命令在 Task 9 落地）。
// lint 约束（packages/ 在 eslint 覆盖内）：不用顶层 await，入口一律 async main + then/catch。
async function main() {
  console.log('saigai-bot：CLI 子命令（run/validate/doctor）将于 Task 9 实现；当前仅有包骨架与配置层。')
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error('saigai-bot 启动失败：', err && err.message ? err.message : err)
    process.exitCode = 1
  },
)
