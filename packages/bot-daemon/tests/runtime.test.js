import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeStore } from '../runtime.js'

let dir
let file
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-runtime-'))
  file = path.join(dir, 'runtime.json')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('createRuntimeStore（R20 房间覆盖）', () => {
  it('set/get/clear 并持久化重载', () => {
    const s = createRuntimeStore({ file })
    expect(s.setRoomOverride('bot-a', { room: 'amber', baseRoom: 'nebula' })).toBe(true)
    expect(s.getRoomOverride('bot-a')).toEqual({ room: 'amber', baseRoom: 'nebula' })
    expect(s.list()).toEqual({ 'bot-a': { room: 'amber', baseRoom: 'nebula' } })

    const again = createRuntimeStore({ file })
    expect(again.getRoomOverride('bot-a')).toEqual({ room: 'amber', baseRoom: 'nebula' })

    expect(again.clearRoomOverride('bot-a')).toBe(true)
    expect(createRuntimeStore({ file }).getRoomOverride('bot-a')).toBe(null)
  })

  it('非法 id/room 拒绝写入（throw 或 false，且不落盘）', () => {
    const s = createRuntimeStore({ file })
    expect(() => s.setRoomOverride('../x', { room: 'amber', baseRoom: null })).toThrow()
    expect(s.setRoomOverride('bot-a', { room: 'AMBER!', baseRoom: null })).toBe(false)
    expect(s.setRoomOverride('bot-a', { room: 'amber', baseRoom: 'bad room' })).toBe(false)
    expect(s.list()).toEqual({})
    expect(fs.existsSync(file)).toBe(false)
  })

  it('坏文件/错形状 → 空表不抛', () => {
    fs.writeFileSync(file, '{bad')
    expect(createRuntimeStore({ file }).list()).toEqual({})
    fs.writeFileSync(file, JSON.stringify({ version: 1, rooms: [] }))
    expect(createRuntimeStore({ file }).list()).toEqual({})
  })

  it('写失败：set/clear 内存回滚，与磁盘不分叉', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rooms: { 'bot-a': { room: 'amber', baseRoom: 'nebula' } },
    }))
    const failing = createRuntimeStore({ file, writeFileImpl: () => { throw new Error('EIO') } })
    expect(() => failing.setRoomOverride('bot-a', { room: 'magenta', baseRoom: 'nebula' })).toThrow(/EIO/)
    expect(failing.getRoomOverride('bot-a')).toEqual({ room: 'amber', baseRoom: 'nebula' })

    expect(() => failing.clearRoomOverride('bot-a')).toThrow(/EIO/)
    expect(failing.getRoomOverride('bot-a')).toEqual({ room: 'amber', baseRoom: 'nebula' })
    expect(createRuntimeStore({ file }).getRoomOverride('bot-a')).toEqual({ room: 'amber', baseRoom: 'nebula' })
  })

  it('读入时清洗非法条目', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rooms: {
        ok: { room: 'amber', baseRoom: 'nebula' },
        badRoom: { room: 'x', baseRoom: 'nebula' },
        badBase: { room: 'amber', baseRoom: 'y' },
        badId: { room: 'amber', baseRoom: null },
      },
    }))
    expect(createRuntimeStore({ file }).list()).toEqual({
      ok: { room: 'amber', baseRoom: 'nebula' },
    })
  })
})
