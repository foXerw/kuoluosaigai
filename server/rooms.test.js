import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PUBLIC_ROOM_IDS, genRoomId, createRegistry } from './rooms.js'

// 每个用例独立 tmp 文件，互不污染
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-'))
  return path.join(dir, 'rooms.txt')
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

describe('genRoomId', () => {
  it('produces 6-char [a-z0-9] ids, 50 calls without throw and with variety', () => {
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      const id = genRoomId()
      expect(id).toMatch(/^[a-z0-9]{6}$/)
      seen.add(id)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('uses the injected rng over the char table (0 → aaaaaa)', () => {
    expect(genRoomId(() => 0)).toBe('aaaaaa')
  })
})

describe('createRegistry', () => {
  it('seeds a missing file with exactly the PUBLIC_ROOM_IDS lines', () => {
    const file = tmpFile()
    createRegistry(file)
    expect(readLines(file)).toEqual(PUBLIC_ROOM_IDS)
  })

  it('has() recognizes seeded rooms and rejects unknown ids', () => {
    const reg = createRegistry(tmpFile())
    expect(reg.has('nebula')).toBe(true)
    expect(reg.has('zzzzzz')).toBe(false)
  })

  it('add() appends a new id once; duplicate add is a no-op returning false', () => {
    const file = tmpFile()
    const reg = createRegistry(file)
    expect(reg.add('abc123')).toBe(true)
    expect(readLines(file)).toEqual([...PUBLIC_ROOM_IDS, 'abc123'])
    expect(reg.add('abc123')).toBe(false)
    expect(readLines(file)).toHaveLength(5)
  })

  it('add() propagates a write failure without touching the in-memory Set (file first, then Set)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuo-'))
    const file = path.join(dir, 'rooms.txt')
    const reg = createRegistry(file)
    fs.rmSync(dir, { recursive: true, force: true }) // 抽走父目录 → append 必抛 ENOENT
    expect(() => reg.add('zz9999')).toThrow()
    expect(reg.has('zz9999')).toBe(false) // 失败不留内存幽灵 ID（服务层据此可安全继续）
  })

  it('reloads the ledger from disk on restart', () => {
    const file = tmpFile()
    createRegistry(file).add('abc123')
    const reopened = createRegistry(file)
    expect(reopened.has('abc123')).toBe(true)
    // 重启不应把已有条目重复 append 回去
    expect(readLines(file)).toHaveLength(5)
  })
})
