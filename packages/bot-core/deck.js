// deck 主体的宿主无关核心。本任务（Task 3）只放 `createNullLease`——即浏览器
// `createTabLease` 与 daemon「恒真」实现共同遵守的 lease 端口。Task 4 才把 store.js
// 的牌桌逻辑搬进本文件的 createDeck，因此这里刻意保持最小、只认端口的六个成员。
//
// lease 端口契约（与 src/bots/lease.js 的 createTabLease 返回值同名同形）：
//   acquire(botId) → Promise<boolean>
//   release(botId) → void
//   releaseAll()   → void
//   heartbeat(botId) → void
//   isHeldElsewhere(botId) → boolean
//   degraded → boolean
// deck 只依赖这六个成员，多出来的一律不依赖。

/**
 * daemon 侧的 lease 实现：没有跨标签竞争，永远授权。语义与浏览器侧一致，
 * 只是所有判断恒真/恒无降级，供 createDeck 注入同一个端口对象时无需分支。
 * @returns {{
 *   acquire: (botId: string) => Promise<true>,
 *   release: (botId: string) => void,
 *   releaseAll: () => void,
 *   heartbeat: (botId: string) => void,
 *   isHeldElsewhere: (botId: string) => false,
 *   degraded: false,
 * }}
 */
export function createNullLease() {
  return {
    acquire: async () => true,
    release: () => {},
    releaseAll: () => {},
    heartbeat: () => {},
    isHeldElsewhere: () => false,
    degraded: false,
  }
}
