import fs from 'node:fs'
import path from 'node:path'

// 预置公共房间：注册表文件缺行时在构造阶段补写（append-only 账本的种子）
export const PUBLIC_ROOM_IDS = ['setsubun', 'nebula', 'magenta', 'amber']

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_LEN = 6

// 6 字符 [a-z0-9] 房间 ID；rng 可注入以便测试（默认 Math.random）
export function genRoomId(rng = Math.random) {
  let id = ''
  for (let i = 0; i < ID_LEN; i++) {
    id += CHARS[Math.floor(rng() * CHARS.length)]
  }
  return id
}

// append-only 房间注册表：文件每行一个 ID，是全部历史房间的唯一落盘账本。
// 同步 IO 足够：仅在建房时写一行。
export function createRegistry(file, { seed = PUBLIC_ROOM_IDS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ids = new Set()
  if (fs.existsSync(file)) {
    // 按 \n 切行、trim 后非空即入 Set（兼容 \r\n 与尾部空行）
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const id = line.trim()
      if (id) ids.add(id)
    }
  }
  // 种子缺行补写：正常重启应零写入
  for (const id of seed) {
    if (!ids.has(id)) {
      fs.appendFileSync(file, id + '\n')
      ids.add(id)
    }
  }
  return {
    has(id) {
      return ids.has(id)
    },
    // 已存在 → false 不落盘；新 ID → 追加一行并 true
    add(id) {
      if (ids.has(id)) return false
      fs.appendFileSync(file, id + '\n')
      ids.add(id)
      return true
    },
  }
}
