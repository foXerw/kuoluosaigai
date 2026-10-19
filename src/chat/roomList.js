import { PUBLIC_ROOM_IDS } from '../theme/channels'

// 浏览器私有记录：“我认识哪些房间”——只存 ID，绝不存消息。
// 存储键 'kuoluosaigai:rooms'，值为 JSON 字符串数组。

const STORAGE_KEY = 'kuoluosaigai:rooms'

// 模块级内存兜底：隐私模式等场景下 localStorage 读写整体抛错时，
// 本会话内列表仍可在内存中增删（刷新即失，属可接受的降级）。
// 测试通过 __resetFallbackForTest() 重置该可变状态。
let fallback = null

export function __resetFallbackForTest() {
  fallback = null
}

// 读取存储；返回 { ok, ids }，ok=false 表示 getItem 本身抛错（应走内存兜底），
// JSON 坏值/非数组则视为 ok=true + 空列表（存储可用，只是内容是垃圾）。
function readStored(storage) {
  let raw
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch (e) {
    return { ok: false, ids: [] }
  }
  if (raw == null) return { ok: true, ids: [] }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: true, ids: [] }
  }
  return { ok: true, ids: Array.isArray(parsed) ? parsed : [] }
}

function writeStored(storage, ids) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch (e) {
    // 写失败（隐私模式）→ 落模块级内存兜底，本会话仍可用
    fallback = ids.slice()
  }
}

// 规范化：公共房恒在前（按 CHANNELS 顺序），其余按存储顺序；
// 去重并过滤非法项（非字符串、空串）。
function normalize(ids) {
  const seen = new Set(PUBLIC_ROOM_IDS)
  const rest = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    rest.push(id)
  }
  return [...PUBLIC_ROOM_IDS, ...rest]
}

// 当前有效列表 + 是否读写抛错（抛错则附带兜底列表）
function current(storage) {
  const { ok, ids } = readStored(storage)
  if (ok) return normalize(ids)
  if (!fallback) fallback = [...PUBLIC_ROOM_IDS]
  return normalize(fallback)
}

export function loadRooms(storage = localStorage) {
  return current(storage)
}

export function addRoom(roomId, storage = localStorage) {
  const list = current(storage)
  const next = list.includes(roomId) ? list : [...list, roomId]
  writeStored(storage, next)
  return next
}

export function removeRoom(roomId, storage = localStorage) {
  if (PUBLIC_ROOM_IDS.includes(roomId)) {
    // 公共房不可删除：拒绝并原样返回当前列表
    return current(storage)
  }
  const next = current(storage).filter((id) => id !== roomId)
  writeStored(storage, next)
  return next
}
