// roomId 为公共房稳定标识（prefix 小写）。
// 注意：这四个字面量与 server/rooms.js 的 PUBLIC_ROOM_IDS 是双向镜像——
// 任何一侧改动必须同步另一侧，否则前端预置房列表与服务端种子账本会静默分叉。
export const CHANNELS = [
  { roomId: 'setsubun', freq: '7741', prefix: 'SETSUBUN', color: '#39ff14', glow: '#39ff14' },
  { roomId: 'nebula',   freq: '0313', prefix: 'NEBULA',   color: '#22d3ee', glow: '#22d3ee' },
  { roomId: 'magenta',  freq: '0990', prefix: 'MAGENTA',  color: '#ff2d95', glow: '#ff2d95' },
  { roomId: 'amber',    freq: '1882', prefix: 'AMBER',    color: '#ffb000', glow: '#ffb000' },
]

// 与 server/rooms.js PUBLIC_ROOM_IDS 字面量镜像（见上方注释）
export const PUBLIC_ROOM_IDS = CHANNELS.map((c) => c.roomId)

export function channelByRoomId(roomId) {
  return CHANNELS.find((c) => c.roomId === roomId) ?? null
}

const STORAGE_KEY = 'kuoluosaigai:channel'

export function codename(channel) {
  return `${channel.prefix}-${channel.freq}`
}

export function pickChannel(rng = Math.random) {
  let stored = null
  try {
    stored = sessionStorage.getItem(STORAGE_KEY)
  } catch (e) {
    // sessionStorage unavailable (e.g. privacy mode) — fall through to fresh pick
  }
  if (stored) {
    const found = CHANNELS.find((c) => c.freq === stored)
    if (found) return found
  }
  const channel = pickByRng(rng)
  try {
    sessionStorage.setItem(STORAGE_KEY, channel.freq)
  } catch (e) {
    // sessionStorage unavailable — return channel without persisting
  }
  return channel
}

export function reshuffleChannel(rng = Math.random) {
  const channel = pickByRng(rng)
  try {
    sessionStorage.setItem(STORAGE_KEY, channel.freq)
  } catch (e) {
    // sessionStorage unavailable — return channel without persisting
  }
  return channel
}

function pickByRng(rng) {
  return CHANNELS[Math.min(Math.floor(rng() * CHANNELS.length), CHANNELS.length - 1)]
}
