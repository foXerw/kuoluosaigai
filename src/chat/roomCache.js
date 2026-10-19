// 客户端房间消息 LRU 内存缓存（spec §5.2：服务端不存消息，历史仅活在浏览器本缓存中）。
// 纯 ESM 模块，不依赖 Vue。Map 的迭代序天然是插入序，用作 MRU 链表：
// touch = delete + set（把房间挪到末尾）；淘汰 victim = map.keys().next().value（最旧头部）。
// 所有写操作与 get/touch 都把该房刷成 MRU，因此刚被操作的房间（=MRU）永不是淘汰 victim，
// 当前活跃房被 useChat 高频触碰即受结构性保护，无需特判 "current room"。
// 消息帧视为不透明对象原样存储（与 historyMerge 共享引用）：不深拷贝、不修改帧内容；
// get 返回内部数组引用（同一数组，内部一致），调用方不应自行变异它。

/**
 * 创建房间消息缓存。
 * @param {{maxRooms?: number, maxPerRoom?: number}} [options]
 *   maxRooms   同时驻留的房间数上限，新建房间超限时逐出 LRU（默认 20）
 *   maxPerRoom  每房消息条数上限，超出丢最旧保留最新（默认 500）
 * @returns {{
 *   get: (roomId: string) => Array,
 *   replace: (roomId: string, msgs: Array) => void,
 *   append: (roomId: string, msg: object) => void,
 *   drop: (roomId: string) => void,
 *   touch: (roomId: string) => void,
 * }}
 */
export function createRoomCache({ maxRooms = 20, maxPerRoom = 500 } = {}) {
  const map = new Map() // roomId → 消息帧数组（插入序 = LRU 序，末尾为 MRU）

  // 把已有房间挪到 Map 末尾（= 最新使用）。未知房间是 no-op，绝不凭空建档。
  function touch(roomId) {
    const msgs = map.get(roomId)
    if (msgs === undefined) return
    map.delete(roomId)
    map.set(roomId, msgs)
  }

  // 超限逐出：被操作的房间刚被挪到末尾（MRU），头部 keys 只会是其他房间。
  function evictOverflow() {
    while (map.size > maxRooms) {
      const victim = map.keys().next().value
      if (victim === undefined) break
      map.delete(victim)
    }
  }

  function get(roomId) {
    const msgs = map.get(roomId)
    if (msgs === undefined) return []
    touch(roomId)
    return msgs
  }

  function append(roomId, msg) {
    let msgs = map.get(roomId)
    const isNew = msgs === undefined
    if (isNew) msgs = []
    msgs.push(msg)
    if (msgs.length > maxPerRoom) msgs.splice(0, msgs.length - maxPerRoom)
    map.set(roomId, msgs) // 新房建档 / 旧房原位更新（引用不变）
    touch(roomId)
    if (isNew) evictOverflow() // 仅新建房间可能推高 size；已有房 append 不触发逐出
  }

  function replace(roomId, msgs) {
    const arr = Array.isArray(msgs) ? msgs.slice(-maxPerRoom) : []
    const isNew = !map.has(roomId)
    map.delete(roomId)
    map.set(roomId, arr)
    if (isNew) evictOverflow()
  }

  function drop(roomId) {
    map.delete(roomId)
  }

  return { get, replace, append, drop, touch }
}
