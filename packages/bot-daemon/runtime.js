// P3b / R20：远端房间切换的持久化覆盖。
//
// 配置拥有定义（Q2），daemon 永不回写配置文件；但手机切了房后进程重启不能蒸发。
// 折中：runtime.json 只存「房间」这一项运行时状态，并记录切换时的**配置房**
// （baseRoom）。启动/热重载时：
//   - baseRoom === 当前配置房 → 应用覆盖（用户没在配置里改房）；
//   - 不一致 → 配置房变过，清覆盖，配置赢。
// 其余远端修改（人格/增删 bot）不入此文件：重启回配置，面板必须如实说明。

import fs from 'node:fs'
import path from 'node:path'

export const RUNTIME_FILE_NAME = 'runtime.json'
export const RUNTIME_VERSION = 1
const ID_RE = /^[a-z0-9-]{1,32}$/
// 私房固定 6 位；四个公共房是 5–8 位（amber/magenta/setsubun…），不能按 6 位一刀切。
const ROOM_RE = /^[a-z0-9]{5,8}$/

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validBase(v) {
  return v === null || v === undefined || (typeof v === 'string' && ROOM_RE.test(v))
}

function readDoc(file) {
  const empty = { version: RUNTIME_VERSION, rooms: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isObject(parsed) || !isObject(parsed.rooms)) return empty
    for (const [id, o] of Object.entries(parsed.rooms)) {
      if (!ID_RE.test(id) || !isObject(o)) continue
      if (typeof o.room !== 'string' || !ROOM_RE.test(o.room)) continue
      if (!validBase(o.baseRoom)) continue
      empty.rooms[id] = { room: o.room, baseRoom: o.baseRoom ?? null }
    }
    return empty
  } catch (e) {
    return empty
  }
}

function clone(v) {
  return v ? { ...v } : null
}

export function createRuntimeStore({ file }) {
  const doc = readDoc(file)

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    let moved = false
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
      fs.renameSync(tmp, file)
      moved = true
    } finally {
      if (!moved) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch (e) {
          /* 不掩盖原始异常 */
        }
      }
    }
  }

  return {
    path: file,
    list() {
      const out = {}
      for (const [id, o] of Object.entries(doc.rooms)) out[id] = clone(o)
      return out
    },
    getRoomOverride(id) {
      return clone(doc.rooms[id])
    },
    setRoomOverride(id, { room, baseRoom } = {}) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('runtime: invalid bot id')
      if (typeof room !== 'string' || !ROOM_RE.test(room)) return false
      if (!validBase(baseRoom)) return false
      doc.rooms[id] = { room, baseRoom: baseRoom ?? null }
      persist()
      return true
    },
    clearRoomOverride(id) {
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(doc.rooms, id)) return false
      delete doc.rooms[id]
      persist()
      return true
    },
  }
}
