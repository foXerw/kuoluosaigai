// Task 5：state.json 旁挂存储适配器测试（Q2/§16.5）。
// A1 红线用「读落盘文件原始文本搜 key」钉死——不信任序列化器；孤儿保留覆盖 Q2 的
// 误删 / 复用退役 / 崩溃窗口 / 二次消失并账四条链；失败路径（坏 JSON、IO 错误、
// 中途写失败、畸形输入）逐个验证「不崩 daemon」。
// 本目录跑在 node 工程（vitest.config.js，裁定 R6）；lint 约束与 Task 4 相同：无顶层 await。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createFileStateStore } from '../state.js'
import { CONFIG_KEY, SCHEMA_VERSION, createDeck } from 'kuoluosaigai-bot-core'

const SECRET_KEY = 'sk-SUPERSECRET-do-not-leak-9f3a'

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-state-test-'))
})
afterAll(() => {
  // beforeAll 失败时 tmpRoot 是 undefined——rmSync 对非字符串必抛（force 不容不通向），先守卫。
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

// —— 载荷构造：与 deck.persist() 的产物同形 ——
// 关键：apiKey/persona/rawPrompt 等字段**必然在场**（persist 用 pick(p, PROVIDER_KEYS)），
// 这正是本适配器要剥的；用「核心真实会写的形状」测剥离，才测得到红线。
function coreProvider(over) {
  return Object.assign(
    { id: 'provider-1', name: 'ds', baseUrl: 'https://api.deepseek.com/v1', apiKey: SECRET_KEY },
    over || {},
  )
}

function coreBot(over) {
  return Object.assign(
    {
      id: 'lixiao', name: '小李', persona: '大三学生，说话短', chattiness: 50,
      providerId: 'provider-1', model: 'deepseek-chat', temperature: 0.9, rawPrompt: '',
      roomId: 'nebula', nick: null,
    },
    over || {},
  )
}

function corePayload(bots, lifetime) {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    providers: [coreProvider()],
    bots,
    lifetime: lifetime || {},
  })
}

function readDoc(store) {
  return JSON.parse(fs.readFileSync(store.path, 'utf8'))
}

describe('A1 红线与落盘形状：key 死在适配器这一层', () => {
  it('setItem 落盘后，文件原始文本中搜不到 apiKey 明文（Review Focus #2）', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ nick: 'ANON-7C2D' })], { lixiao: { promptTokens: 1, completionTokens: 2 } }))
    const raw = fs.readFileSync(store.path, 'utf8')
    expect(raw).toContain('provider-1') // sanity：确实写盘了，不是空文件蒙混
    expect(raw).not.toContain(SECRET_KEY)
    expect(raw).not.toContain('apiKey') // 字段名都不出现——白名单剥离，不是置空
    expect(raw).not.toContain('persona')
    expect(raw).not.toContain('rawPrompt')
  })

  it('落盘形状：providers 只剩 {id,name,baseUrl}；bots 只剩 {id,nick}', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ nick: 'ANON-7C2D' })], { lixiao: { promptTokens: 10, completionTokens: 5 } }))
    const doc = readDoc(store)
    expect(Object.keys(doc).sort()).toEqual(['bots', 'lifetime', 'orphans', 'providers', 'version'])
    expect(doc.version).toBe(SCHEMA_VERSION)
    expect(doc.providers).toEqual([{ id: 'provider-1', name: 'ds', baseUrl: 'https://api.deepseek.com/v1' }])
    expect(doc.bots).toEqual([{ id: 'lixiao', nick: 'ANON-7C2D' }])
    expect(doc.lifetime).toEqual({ lixiao: { promptTokens: 10, completionTokens: 5 } })
    expect(doc.orphans).toEqual({})
  })
})

describe('只服务 CONFIG_KEY（daemon 侧没有第二个 deck 键）', () => {
  it('getItem：无文件返回 null；其它键即便有文件也返回 null', () => {
    const store = createFileStateStore({ dir: freshDir() })
    expect(store.getItem(CONFIG_KEY)).toBe(null)
    store.setItem(CONFIG_KEY, corePayload([coreBot()], {}))
    expect(store.getItem(CONFIG_KEY + ':nope')).toBe(null)
  })

  it('setItem 其它键 → 直接忽略：不落盘、不造第二个 store，连目录都不建', () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    store.setItem(CONFIG_KEY + ':nope', '{"apiKey":"' + SECRET_KEY + '"}')
    expect(fs.existsSync(store.path)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([]) // 若曾落任何盘（含 .tmp）都会在这里现形
  })

  it('removeItem 其它键不动 state 文件；removeItem(CONFIG_KEY) 整文件删除', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot()], {}))
    store.removeItem(CONFIG_KEY + ':nope')
    expect(fs.existsSync(store.path)).toBe(true)
    store.removeItem(CONFIG_KEY)
    expect(fs.existsSync(store.path)).toBe(false)
    expect(store.getItem(CONFIG_KEY)).toBe(null)
    expect(store.readOrphans()).toEqual({})
  })
})

describe('孤儿身份保留（Q2：误删配置不丢身份）', () => {
  it('botId 从新 payload 消失 → orphans[id] 保 nick 与 lifetime', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'lixiao', nick: 'ANON-7C2D' })], { lixiao: { promptTokens: 10, completionTokens: 5 } }))
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'aqiang', nick: null })], {}))
    const expected = { lixiao: { nick: 'ANON-7C2D', lifetime: { promptTokens: 10, completionTokens: 5 } } }
    expect(readDoc(store).orphans).toEqual(expected)
    expect(store.readOrphans()).toEqual(expected)
  })

  it('getItem 供入不夹带 orphans：core 读到的载荷只有 version/providers/bots/lifetime', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], { a: { promptTokens: 10, completionTokens: 5 } }))
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'b', nick: 'ANON-B' })], { b: { promptTokens: 1, completionTokens: 1 } }))
    const served = store.getItem(CONFIG_KEY)
    expect(served).not.toContain('orphans')
    expect(served).not.toContain('ANON-A') // 孤儿身份绝不回流
    expect(Object.keys(JSON.parse(served)).sort()).toEqual(['bots', 'lifetime', 'providers', 'version'])
  })

  it('重启场景：新实例以盘上文档为比较基准，停机期间被删的 id 照样进 orphans', () => {
    const dir = freshDir()
    const s1 = createFileStateStore({ dir })
    s1.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' }), coreBot({ id: 'b' })], {}))
    const s2 = createFileStateStore({ dir }) // 模拟 daemon 重启：内存基准为空
    expect(s2.path).toBe(s1.path)
    s2.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'b' })], {}))
    expect(s2.readOrphans()).toEqual({ a: { nick: 'ANON-A', lifetime: null } })
  })

  it('同 id 再现且载荷已带全 nick 与账目 → orphans 条目退役（数据来源归一于载荷）', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], { a: { promptTokens: 10, completionTokens: 5 } }))
    store.setItem(CONFIG_KEY, corePayload([], {}))
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], { a: { promptTokens: 12, completionTokens: 6 } }))
    expect(store.readOrphans()).toEqual({})
    expect(readDoc(store).orphans).toEqual({})
  })

  it('再现但身份尚未回填（崩溃窗口）→ orphans 不退役、不被空值覆盖', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], { a: { promptTokens: 10, completionTokens: 5 } }))
    store.setItem(CONFIG_KEY, corePayload([], {})) // 误删 → 进 orphans
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: null })], {})) // 刚 addBot，updateBot(nick) 未及落地
    expect(store.readOrphans()).toEqual({ a: { nick: 'ANON-A', lifetime: { promptTokens: 10, completionTokens: 5 } } })
  })

  it('同 id 二次消失：账目并账、旧 nick 不被空值冲掉（累计不丢）', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], { a: { promptTokens: 10, completionTokens: 5 } }))
    store.setItem(CONFIG_KEY, corePayload([], {})) // orphans: {ANON-A, 10/5}
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: null })], { a: { promptTokens: 3, completionTokens: 4 } })) // 复用后重新记账
    store.setItem(CONFIG_KEY, corePayload([], {})) // 再消失 → 并账
    expect(store.readOrphans()).toEqual({ a: { nick: 'ANON-A', lifetime: { promptTokens: 13, completionTokens: 9 } } })
  })

  it('core 往返：deck.load() 直接吃本文件——nick/lifetime 落地、provider.apiKey 为空串、orphans 不进 deck', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'lixiao', nick: 'ANON-7C2D' })], { lixiao: { promptTokens: 10, completionTokens: 5 } }))
    const deck = createDeck({ storage: store })
    deck.load()
    expect(deck.bots.map((b) => b.id)).toEqual(['lixiao'])
    expect(deck.bots[0].nick).toBe('ANON-7C2D')
    expect(deck.providers[0].apiKey).toBe('') // 文件没 key，deck 也就没 key——回流通道不存在
    expect(deck.lifetime.lixiao).toEqual({ promptTokens: 10, completionTokens: 5 })
    // 误删收敛后：orphans 只活在文件层，deck 视野干净
    store.setItem(CONFIG_KEY, corePayload([], {}))
    deck.load()
    expect(deck.bots).toEqual([])
    expect(deck.lifetime).toEqual({})
    deck.dispose()
  })
})

describe('失败路径：读与写都不许崩 daemon', () => {
  it('getItem 读坏 JSON → null（交给 core 的 B15 重建），不抛', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'state.json'), '{"version":1, "providers": [ 半写状态')
    const store = createFileStateStore({ dir })
    expect(store.getItem(CONFIG_KEY)).toBe(null)
    expect(store.readOrphans()).toEqual({})
  })

  it('IO 读失败（state.json 是目录）→ getItem 返回 null 不抛；写失败抛给调用方且不留 .tmp', () => {
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, 'state.json'))
    const store = createFileStateStore({ dir })
    expect(store.getItem(CONFIG_KEY)).toBe(null)
    expect(store.readOrphans()).toEqual({})
    // 写路径 rename 到目录必失败：错误上抛由 core 的 B17 try/catch 接住（适配器不吞真故障），
    // 但绝不许留下半个 .tmp。
    expect(() => store.setItem(CONFIG_KEY, corePayload([], {}))).toThrow()
    expect(fs.existsSync(store.path + '.tmp')).toBe(false)
  })

  it('setItem 畸形输入（非 JSON / 非对象 / 数组 / 非字符串）→ 静默忽略，原文绝不落盘', () => {
    const dir = freshDir()
    const store = createFileStateStore({ dir })
    store.setItem(CONFIG_KEY, 'not JSON at all {')
    store.setItem(CONFIG_KEY, '123')
    store.setItem(CONFIG_KEY, '[1,2]')
    store.setItem(CONFIG_KEY, '"just a string"')
    store.setItem(CONFIG_KEY, null)
    store.setItem(CONFIG_KEY, 42)
    expect(fs.existsSync(store.path)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('畸形输入的错误面收口（A3）：不抛异常、不外露 JSON.parse 报错文本（其中可能含输入切片）', () => {
    const store = createFileStateStore({ dir: freshDir() })
    expect(() => store.setItem(CONFIG_KEY, 'oops ' + SECRET_KEY)).not.toThrow()
    expect(fs.existsSync(store.path)).toBe(false)
  })

  it('原子写：写盘中途异常不留半个文件（旧文件原样、无 .tmp 残留、恢复后可继续写）', () => {
    const store = createFileStateStore({ dir: freshDir() })
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'a', nick: 'ANON-A' })], {}))
    const before = fs.readFileSync(store.path, 'utf8')
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('模拟写盘中途失败')
    })
    let caught = null
    try {
      store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'b' })], {}))
    } catch (e) {
      caught = e
    } finally {
      spy.mockRestore()
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught.message).toContain('模拟写盘中途失败') // 错误原样上抛（core persist 有 try/catch 兜住 → storageDegraded）
    expect(fs.readFileSync(store.path, 'utf8')).toBe(before) // 最终文件仍是旧内容，不会半新半旧
    expect(fs.existsSync(store.path + '.tmp')).toBe(false)
    store.setItem(CONFIG_KEY, corePayload([coreBot({ id: 'b' })], {})) // 恢复正常：仍可写，且失败那次没污染基准
    expect(readDoc(store).bots).toEqual([{ id: 'b', nick: null }])
    expect(readDoc(store).orphans).toEqual({ a: { nick: 'ANON-A', lifetime: null } })
  })
})

describe('目录与文件归属', () => {
  it('dir 不存在 → 写盘时递归创建；自定义 fileName 生效且不串默认名', () => {
    const base = freshDir()
    const dir = path.join(base, 'data', 'nested')
    const store = createFileStateStore({ dir, fileName: 'other-state.json' })
    expect(store.path).toBe(path.join(dir, 'other-state.json'))
    store.setItem(CONFIG_KEY, corePayload([], {}))
    expect(fs.existsSync(store.path)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false)
  })
})
