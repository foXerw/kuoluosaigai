// Task 6：进程级单实例锁测试（§7.4 / 反目标 A5）。
// A5 红线「活锁绝不抢」用注入的 isAlive 钉死——测试绝不探测真实系统 PID（假 PID 随意为害）；
// 默认存活探测的两个分支（EPERM→判活、ESRCH→判死）用 process.kill 间谍单独钉。
// 双竞争者接管竞态不依赖真并发：vi.spyOn(fs, …) 注入 read/unlink 的交错时序，
// 构造「都盯着同一份陈旧锁」，断言恰好一个赢、另一个拒绝（两个交错方向各钉一条）。
// 本目录跑在 node 工程（vitest.config.js，裁定 R6）；lint 约束与 Task 4/5 相同：无顶层 await。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { acquireLock } from '../lock.js'

let tmpRoot
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-lock-test-'))
})
afterAll(() => {
  // beforeAll 失败时 tmpRoot 是 undefined——rmSync 对非字符串必抛（force 不容不通向），先守卫（Task 5 教训）。
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function freshDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}

const DEFAULT_NAME = 'saigai-bot.lock'

function lockPathOf(dir, fileName = DEFAULT_NAME) {
  return path.join(dir, fileName)
}

function readLock(dir, fileName = DEFAULT_NAME) {
  return JSON.parse(fs.readFileSync(lockPathOf(dir, fileName), 'utf8'))
}

// 陈旧锁的 pid 与两个竞争者 pid：一律由注入的 isAlive 决定生死，绝不碰真进程。
const DEAD_PID = 999999
const PID_A = 111
const PID_B = 222
const aliveRivals = (p) => p === PID_A || p === PID_B

function seedStaleLock(dir, fileName = DEFAULT_NAME) {
  fs.writeFileSync(lockPathOf(dir, fileName), JSON.stringify({ pid: DEAD_PID, startedAt: 1000 }))
}

describe('常态拿锁：O_EXCL 写出与 release 收尸', () => {
  it('无锁 → ok:true, tookOver:false，写出含 pid/startedAt 的文件；release 删除之', () => {
    const dir = freshDir()
    const res = acquireLock({ dir, pid: PID_A, startedAt: 123, isAlive: aliveRivals })
    expect(res.ok).toBe(true)
    expect(res.tookOver).toBe(false)
    expect(typeof res.release).toBe('function')
    expect(fs.existsSync(lockPathOf(dir))).toBe(true)
    expect(readLock(dir)).toEqual({ pid: PID_A, startedAt: 123 })
    res.release()
    expect(fs.existsSync(lockPathOf(dir))).toBe(false)
  })

  it('锁文件内容只有 {pid, startedAt}——凭据绝不进锁（A3）', () => {
    const dir = freshDir()
    const res = acquireLock({ dir, pid: PID_A, startedAt: 42, isAlive: aliveRivals })
    expect(Object.keys(readLock(dir)).sort()).toEqual(['pid', 'startedAt'])
    res.release()
  })

  it('默认 fileName 是 saigai-bot.lock；显式覆盖则写进指定文件（互斥只在同名下成立）', () => {
    const dir = freshDir()
    const a = acquireLock({ dir, pid: PID_B, startedAt: 1, isAlive: aliveRivals })
    const b = acquireLock({ dir, fileName: 'other.lock', pid: PID_A, startedAt: 2, isAlive: aliveRivals })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true) // 不同文件名 = 两把互不相干的锁；Task 9 统一走默认名才构成互斥
    expect(readLock(dir)).toEqual({ pid: PID_B, startedAt: 1 })
    expect(readLock(dir, 'other.lock')).toEqual({ pid: PID_A, startedAt: 2 })
    a.release()
    b.release()
  })

  it('锁存在且持有者 PID 存活 → ok:false 并报出对方 pid；盘上分毫未动（A5 绝不抢活锁）', () => {
    const dir = freshDir()
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ pid: PID_B, startedAt: 7 }))
    const res = acquireLock({ dir, pid: PID_A, startedAt: 8, isAlive: aliveRivals })
    expect(res.ok).toBe(false)
    expect(res.holder).toEqual({ pid: PID_B, startedAt: 7 })
    expect(readLock(dir)).toEqual({ pid: PID_B, startedAt: 7 }) // 不 unlink、不覆写、不重试
  })

  it('同进程二次 acquire（默认 isAlive 探真 PID，必活）→ ok:false——重启前忘了 release 也拒绝双跑', () => {
    const dir = freshDir()
    const first = acquireLock({ dir, pid: process.pid, startedAt: 1000 })
    expect(first.ok).toBe(true)
    const second = acquireLock({ dir, pid: process.pid, startedAt: 2000 })
    expect(second.ok).toBe(false)
    expect(second.holder).toEqual({ pid: process.pid, startedAt: 1000 })
    first.release()
  })

  it('数据目录不存在 → acquireLock 递归创建后再拿锁（首启时 state.json 目录还没建）', () => {
    const dir = path.join(freshDir(), 'nested', 'data')
    const res = acquireLock({ dir, pid: PID_A, startedAt: 1, isAlive: aliveRivals })
    expect(res.ok).toBe(true)
    expect(fs.existsSync(lockPathOf(dir))).toBe(true)
    res.release()
  })
})

describe('陈旧锁判定与接管（调用方据此打 WARN）', () => {
  it('锁存在但 PID 已死 → ok:true, tookOver:true，盘上换成新持有者', () => {
    const dir = freshDir()
    seedStaleLock(dir)
    const res = acquireLock({ dir, pid: PID_A, startedAt: 555, isAlive: aliveRivals })
    expect(res.ok).toBe(true)
    expect(res.tookOver).toBe(true)
    expect(readLock(dir)).toEqual({ pid: PID_A, startedAt: 555 })
    res.release()
  })

  it('锁文件是坏 JSON → 视为陈旧锁接管，不因脏文件永挂', () => {
    const dir = freshDir()
    fs.writeFileSync(lockPathOf(dir), 'not-a-json{{{')
    const res = acquireLock({ dir, pid: PID_A, startedAt: 556, isAlive: aliveRivals })
    expect(res.ok).toBe(true)
    expect(res.tookOver).toBe(true)
    expect(readLock(dir)).toEqual({ pid: PID_A, startedAt: 556 })
    res.release()
  })

  it('锁 JSON 合法但缺字段（pid 不是正整数）→ 同样判陈旧接管', () => {
    const dir = freshDir()
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ startedAt: 1 }))
    const res = acquireLock({ dir, pid: PID_A, startedAt: 557, isAlive: aliveRivals })
    expect(res.ok).toBe(true)
    expect(res.tookOver).toBe(true)
    res.release()
  })

  it('默认存活探测：process.kill 抛 EPERM（进程存在但信号不到）→ 判活拒绝（保守方向，§8.5 Windows 同理）', () => {
    const dir = freshDir()
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ pid: 4242, startedAt: 1 }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill EPERM')
      err.code = 'EPERM'
      throw err
    })
    try {
      const res = acquireLock({ dir, pid: PID_A, startedAt: 2 })
      expect(res.ok).toBe(false)
      expect(res.holder).toEqual({ pid: 4242, startedAt: 1 })
      expect(readLock(dir)).toEqual({ pid: 4242, startedAt: 1 })
    } finally {
      killSpy.mockRestore()
    }
  })

  it('默认存活探测：process.kill 抛 ESRCH（查无此进程）→ 判死接管', () => {
    const dir = freshDir()
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ pid: 4242, startedAt: 1 }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH')
      err.code = 'ESRCH'
      throw err
    })
    try {
      const res = acquireLock({ dir, pid: PID_A, startedAt: 3 })
      expect(res.ok).toBe(true)
      expect(res.tookOver).toBe(true)
      expect(readLock(dir)).toEqual({ pid: PID_A, startedAt: 3 })
      res.release()
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('双竞争者接管竞态：两个都想抢同一份陈旧锁，恰好一个赢', () => {
  it('交错①：A unlink 陈旧锁的瞬间 B 完成整套接管 → B 赢；A 的 O_EXCL 撞墙后回读+判活 → A 拒绝', () => {
    const dir = freshDir()
    seedStaleLock(dir)
    let resB
    let fired = false
    const realUnlink = fs.unlinkSync
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      realUnlink(p)
      if (!fired) {
        fired = true
        // 交错注入：A 已删掉陈旧锁、还没来得及 O_EXCL 写下自己——B 从这一刻整套接管。
        resB = acquireLock({ dir, pid: PID_B, startedAt: 222, isAlive: aliveRivals })
      }
    })
    let resA
    try {
      resA = acquireLock({ dir, pid: PID_A, startedAt: 111, isAlive: aliveRivals })
    } finally {
      unlinkSpy.mockRestore()
    }
    const winners = [resA, resB].filter((r) => r.ok === true)
    expect(winners).toHaveLength(1) // 恰好一个赢——A5 的竞态面钉死在这条
    expect(resB.ok).toBe(true)
    expect(resA.ok).toBe(false) // 输家回到「读锁+判活」，绝不带着「陈旧锁已清」继续跑
    expect(resA.holder).toEqual({ pid: PID_B, startedAt: 222 })
    expect(readLock(dir)).toEqual({ pid: PID_B, startedAt: 222 }) // 盘上只属于赢家
    resB.release()
  })

  it('交错②：B 观察到陈旧锁后、动手 unlink 前 A 完成接管 → B 的确认读看到新主，绝不删 A 的新锁', () => {
    const dir = freshDir()
    seedStaleLock(dir)
    let resA
    let fired = false
    let suspending = false
    let observedReads = 0
    const realRead = fs.readFileSync
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync') // 不 mock 行为，只计数：证明 B 从未 unlink
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      const out = realRead(p, ...rest)
      if (!suspending && String(p) === lockPathOf(dir)) {
        observedReads += 1
        if (observedReads === 2 && !fired) {
          fired = true
          suspending = true
          try {
            // 交错注入：B 盯着陈旧锁 S 决定接管，此刻 A 抢先完成整套接管。
            resA = acquireLock({ dir, pid: PID_A, startedAt: 111, isAlive: aliveRivals })
          } finally {
            suspending = false
          }
          return realRead(p, ...rest) // B 的「unlink 前确认读」读到的是 A 的新锁，不是 out 里的旧 S
        }
      }
      return out
    })
    let resB
    let unlinkPaths
    try {
      resB = acquireLock({ dir, pid: PID_B, startedAt: 222, isAlive: aliveRivals })
    } finally {
      // mockRestore() 会连 mock.calls 历史一并清空（vitest 语义）——调用记录必须在还原前取快照。
      unlinkPaths = unlinkSpy.mock.calls.map((c) => String(c[0]))
      readSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
    expect(resB.ok).toBe(false)
    expect(resB.holder).toEqual({ pid: PID_A, startedAt: 111 })
    expect(resA.ok).toBe(true)
    expect([resA, resB].filter((r) => r.ok === true)).toHaveLength(1)
    expect(unlinkPaths).toEqual([lockPathOf(dir)]) // 唯一一次 unlink 属于 A 清陈旧锁；B 没碰
    expect(readLock(dir)).toEqual({ pid: PID_A, startedAt: 111 }) // A 的锁完好
    resA.release()
  })
})

describe('release 只删自己的锁', () => {
  it('盘上已被他人接管（内容换掉）→ release 是对比照不匹配，no-op，不删他人锁', () => {
    const dir = freshDir()
    const mine = acquireLock({ dir, pid: PID_A, startedAt: 111, isAlive: aliveRivals })
    expect(mine.ok).toBe(true)
    // 场景：我方进程被 SIGKILL、别人判我死并把锁接走；「我」的残留句柄再调 release。
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ pid: PID_B, startedAt: 222 }))
    mine.release()
    expect(readLock(dir)).toEqual({ pid: PID_B, startedAt: 222 })
  })

  it('文件已消失 / 内容已损坏 → release 幂等 no-op 且不抛（无从确认所有权就什么都别删）', () => {
    const dir = freshDir()
    const mine = acquireLock({ dir, pid: PID_A, startedAt: 111, isAlive: aliveRivals })
    fs.rmSync(lockPathOf(dir))
    expect(() => mine.release()).not.toThrow() // 已丢：无物可删
    fs.writeFileSync(lockPathOf(dir), 'garbage{{{')
    mine.release() // 读不出持有者 → 不认领也不删（下次启动按陈旧接管兜底）
    expect(fs.readFileSync(lockPathOf(dir), 'utf8')).toBe('garbage{{{')
  })

  it('release 遇文件系统故障（unlink 抛错）→ 不炸退出路径', () => {
    const dir = freshDir()
    const mine = acquireLock({ dir, pid: PID_A, startedAt: 111, isAlive: aliveRivals })
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('EIO: boom')
    })
    try {
      expect(() => mine.release()).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
