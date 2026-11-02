// 全局 tick 与跨标签租约心跳的共用权威周期（终审 M4 的教训：曾经有两处 15000
// 巧合相等，一处改动另一处静默脱钩）。bot tick / 租约心跳的唯一权威定义放这里，
// src 侧与 daemon 侧都从这里再导出，不得再抄第二份。
// 勿与同名的 WS 保活常量混淆：`server/index.js` 里的 HEARTBEAT_MS=30000 属服务端
// WebSocket keepalive ping 域（先于本包存在、值与用途都不同），按名 grep 全仓会
// 命中两份——那是两个域，不是需要合并的重复。
export const HEARTBEAT_MS = 15000
