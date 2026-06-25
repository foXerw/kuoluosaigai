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
  const stored = sessionStorage.getItem(STORAGE_KEY)
  if (stored) {
    const found = CHANNELS.find((c) => c.freq === stored)
    if (found) return found
  }
  const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)]
  sessionStorage.setItem(STORAGE_KEY, channel.freq)
  return channel
}

export function reshuffleChannel(rng = Math.random) {
  const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)]
  sessionStorage.setItem(STORAGE_KEY, channel.freq)
  return channel
}
