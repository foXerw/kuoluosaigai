// P3b：远端命令白名单（spec §11.4/§11.6 红线 3）。
//
// - 白名单之外一律 'unknown cmd'；`deck.update` 明确 unsupported（设备名归配置）。
// - API key 红线（Q5a）：args 任意深度出现 apiKey 键即拒（fail-closed 深度帽），
//   拒绝文案不回显参数。
// - 远程 bot 增删/人格修改是**运行时**修改，不写配置文件（Q2 配置拥有定义）；
//   只有 bot.switchRoom 按 R20 写 runtime.json。
// - 回执只有 {ok, err}：服务端 dev-res 只转发这两项，面板靠 dev-state 读结果。

const ID_RE = /^[a-z0-9-]{1,32}$/
const ROOM_RE = /^[a-z0-9]{5,8}$/ // 私房 6 位；公共房 5–8 位
const DAEMON_PROVIDER_ID = 'daemon'
const UPDATE_KEYS = ['name', 'persona', 'chattiness', 'temperature', 'model']

export const REMOTE_COMMANDS = [
  'deck.get',
  'bot.add',
  'bot.update',
  'bot.remove',
  'bot.start',
  'bot.stop',
  'bot.switchRoom',
  'buffer.clear',
]

const ok = () => ({ ok: true, err: null })
const fail = (err) => ({ ok: false, err })

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function hasApiKey(v, depth = 0) {
  if (depth > 8) return true
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some((x) => hasApiKey(x, depth + 1))
  if (Object.prototype.hasOwnProperty.call(v, 'apiKey')) return true
  for (const k of Object.keys(v)) if (hasApiKey(v[k], depth + 1)) return true
  return false
}

function validId(v) {
  return typeof v === 'string' && ID_RE.test(v)
}

function validRoom(v) {
  return typeof v === 'string' && ROOM_RE.test(v)
}

export function keyHintOf(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) return null
  return '****' + apiKey.slice(-4)
}

/**
 * 远端 dev-state 投影：只带运行态与 keyHint，绝不含 apiKey。
 * @param {{ snapshot: object, provider?: object }} opts
 */
export function buildDevState({ snapshot, provider } = {}) {
  const p = provider || {}
  const bots = ((snapshot && snapshot.bots) || []).map((b) => ({
    id: b.id,
    name: b.name,
    room: b.room,
    status: b.status,
    nick: b.nick,
    hourCount: b.hourCount,
    session: { ...(b.session || {}) },
    lifetime: { ...(b.lifetime || {}) },
  }))
  return {
    bots,
    providers: [{
      id: DAEMON_PROVIDER_ID,
      name: DAEMON_PROVIDER_ID,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      keyHint: keyHintOf(p.apiKey),
    }],
    at: snapshot && snapshot.meta ? snapshot.meta.generatedAt : null,
  }
}

/**
 * @param {{ deck: object, runtime: object, getConfig: () => object }} opts
 * @returns {{ handle: ({cmd, args}: {cmd?: string, args?: object}) => {ok: boolean, err: string|null} }}
 */
export function createCommandHandler({ deck, runtime, getConfig }) {
  function findBot(id) {
    return deck.bots.find((b) => b.id === id) || null
  }

  function switchRoom(args) {
    const id = args.id
    const room = args.room
    if (!validId(id) || !validRoom(room)) return fail('bad args')
    const item = findBot(id)
    if (!item) return fail('not found')
    const prev = item.rt.roomId || item.roomId
    if (!deck.switchBotRoom(id, room)) return fail('switch failed')
    const baseRoom = (getConfig().bots.find((b) => b.id === id) || {}).room || null
    try {
      if (!runtime || runtime.setRoomOverride(id, { room, baseRoom }) === false) {
        throw new Error('runtime rejected')
      }
    } catch (e) {
      // 覆盖写不进去就把房间切回去：状态与持久化不能分叉。
      if (prev) deck.switchBotRoom(id, prev)
      return fail('runtime write failed')
    }
    return ok()
  }

  return {
    handle({ cmd, args } = {}) {
      const name = typeof cmd === 'string' ? cmd : ''
      if (name === 'deck.update') return fail('unsupported')
      if (!REMOTE_COMMANDS.includes(name)) return fail('unknown cmd')
      const a = isObject(args) ? args : {}
      if (hasApiKey(a)) return fail('bad args')

      switch (name) {
        case 'deck.get':
          return ok()
        case 'bot.add': {
          const id = a.id
          const botName = a.name
          const room = a.room
          if (!validId(id) || typeof botName !== 'string' || !botName || botName.length > 12 || !validRoom(room)) {
            return fail('bad args')
          }
          const cfg = getConfig()
          const cfg0 = {
            id,
            name: botName,
            persona: typeof a.persona === 'string' ? a.persona : '',
            chattiness: a.chattiness === undefined ? 50 : a.chattiness,
            temperature: a.temperature === undefined ? 0.9 : a.temperature,
            roomId: room,
            providerId: DAEMON_PROVIDER_ID,
          }
          if (typeof a.model === 'string' && a.model) cfg0.model = a.model
          else if (cfg.provider && typeof cfg.provider.model === 'string' && cfg.provider.model) cfg0.model = cfg.provider.model
          if (!Number.isFinite(cfg0.chattiness) || cfg0.chattiness < 0 || cfg0.chattiness > 100) return fail('bad args')
          if (!Number.isFinite(cfg0.temperature) || cfg0.temperature < 0 || cfg0.temperature > 2) return fail('bad args')
          const res = deck.addBot(cfg0)
          if (!res || res.error) return fail(res && res.error === 'MAX_BOTS' ? 'max bots' : 'add failed')
          return ok()
        }
        case 'bot.update': {
          const id = a.id
          if (!validId(id)) return fail('bad args')
          const patch = {}
          for (const k of UPDATE_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(a, k)) continue
            const v = a[k]
            if (k === 'name') {
              if (typeof v !== 'string' || !v || v.length > 12) return fail('bad args')
            } else if (k === 'persona') {
              if (typeof v !== 'string') return fail('bad args')
            } else if (k === 'chattiness') {
              if (!Number.isFinite(v) || v < 0 || v > 100) return fail('bad args')
            } else if (k === 'temperature') {
              if (!Number.isFinite(v) || v < 0 || v > 2) return fail('bad args')
            } else if (k === 'model') {
              if (typeof v !== 'string' || !v) return fail('bad args')
            }
            patch[k] = v
          }
          const unknown = Object.keys(a).filter((k) => k !== 'id' && !UPDATE_KEYS.includes(k))
          if (unknown.length > 0 || Object.keys(patch).length === 0) return fail('bad args')
          if (!findBot(id)) return fail('not found')
          deck.updateBot(id, patch)
          return ok()
        }
        case 'bot.remove': {
          if (!validId(a.id)) return fail('bad args')
          if (!findBot(a.id)) return fail('not found')
          deck.stopBot(a.id)
          deck.removeBot(a.id)
          return ok()
        }
        case 'bot.start': {
          if (!validId(a.id)) return fail('bad args')
          if (!findBot(a.id)) return fail('not found')
          Promise.resolve(deck.startBot(a.id)).catch(() => {})
          return ok()
        }
        case 'bot.stop': {
          if (!validId(a.id)) return fail('bad args')
          if (!findBot(a.id)) return fail('not found')
          deck.stopBot(a.id)
          return ok()
        }
        case 'bot.switchRoom':
          return switchRoom(a)
        case 'buffer.clear': {
          if (!validId(a.id)) return fail('bad args')
          if (!findBot(a.id)) return fail('not found')
          deck.clearBotBuffer(a.id)
          return ok()
        }
        default:
          return fail('unknown cmd')
      }
    },
  }
}
