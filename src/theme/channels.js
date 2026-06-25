export const CHANNELS = [
  { freq: '7741', prefix: 'SETSUBUN', color: '#39ff14', glow: '#39ff14' },
  { freq: '0313', prefix: 'NEBULA',   color: '#22d3ee', glow: '#22d3ee' },
  { freq: '0990', prefix: 'MAGENTA',  color: '#ff2d95', glow: '#ff2d95' },
  { freq: '1882', prefix: 'AMBER',    color: '#ffb000', glow: '#ffb000' },
]

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
