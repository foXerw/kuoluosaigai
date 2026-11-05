import { describe, it, expect } from 'vitest'
import { mergeHistory } from 'kuoluosaigai-bot-core'

// 消息帧形状（Task 2/3 合同）：{ id, ts, roomId, nick, badge, text }
function msg(id, ts, extra = {}) {
  return { id, ts, roomId: 'room-a', nick: 'NICK', badge: 'SETSUBUN', text: `text-${id}`, ...extra }
}

function ids(list) {
  return list.map((m) => m.id)
}

describe('mergeHistory', () => {
  it('单响应者：全采纳，按 ts 升序并入 existing', () => {
    const existing = [msg('e1', 200)]
    const responses = [{ messages: [msg('r1', 100), msg('r2', 300)] }]
    const out = mergeHistory(existing, responses)
    expect(ids(out)).toEqual(['r1', 'e1', 'r2'])
  })

  it('双响应者：仅 ≥2 佐证 id 保留；existing 不受否决', () => {
    // existing 里有 a、c，但响应者各自只佐证 1 票的 a/c 不会被"否决"掉
    const existing = [msg('x', 50), msg('a', 400), msg('c', 500)]
    const responses = [
      { messages: [msg('a', 400), msg('b', 450)] },
      { messages: [msg('b', 450), msg('c', 500)] },
    ]
    const out = mergeHistory(existing, responses)
    // b 有 2 票 → 采纳；a/c 虽只有 1 票响应者佐证，但来自 existing → 保留
    expect(ids(out)).toEqual(['x', 'a', 'b', 'c'])
  })

  it('双响应者：仅一方携带且不在 existing 中的 id 被丢弃', () => {
    const existing = [msg('x', 50)]
    const responses = [
      { messages: [msg('a', 400), msg('b', 450)] },
      { messages: [msg('b', 450), msg('c', 500)] },
    ]
    const out = mergeHistory(existing, responses)
    // b（2 票）采纳，a/c（1 票）丢弃
    expect(ids(out)).toEqual(['x', 'b'])
  })

  it('同 id 跨响应者内容不一致（text 篡改）→ 该 id 整个丢弃', () => {
    const existing = []
    const responses = [
      { messages: [msg('a', 100), msg('b', 200)] },
      { messages: [msg('a', 100, { text: 'tampered' }), msg('b', 200)] },
    ]
    const out = mergeHistory(existing, responses)
    // a 有 2 票但内容冲突 → 丢弃；b 一致且 2 票 → 保留
    expect(ids(out)).toEqual(['b'])
  })

  it('内容冲突不否决 existing 中的同 id 消息（existing 优先）', () => {
    const existing = [msg('a', 100, { text: 'mine' })]
    const responses = [
      { messages: [msg('a', 100, { text: 'v1' })] },
      { messages: [msg('a', 100, { text: 'v2' })] },
    ]
    const out = mergeHistory(existing, responses)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(existing[0])
  })

  it('同一响应者内部重复 id 只计 1 票（首见为准），且输出只出现一次', () => {
    // a 在 r1 内部出现两次、r2 缺席 → 有效票数 1（<2）→ 丢弃
    const responses1 = [
      { messages: [msg('a', 100), msg('a', 100, { text: 'dup' })] },
      { messages: [msg('b', 200)] },
    ]
    const out1 = mergeHistory([], responses1)
    expect(out1).toEqual([])

    // a 在 r1 内部重复 + r2 佐证 → 有效票数 2 → 采纳一次（内容取首见）
    const responses2 = [
      { messages: [msg('a', 100, { text: 'first' }), msg('a', 100, { text: 'dup' })] },
      { messages: [msg('a', 100, { text: 'first' })] },
    ]
    const out2 = mergeHistory([], responses2)
    expect(out2).toHaveLength(1)
    expect(out2[0].text).toBe('first')
  })

  it('排序：ts 升序，同 ts 按 id 字典序', () => {
    const responses = [
      {
        messages: [
          msg('m3', 300),
          msg('m1', 100),
          msg('mb', 200),
          msg('ma', 200),
          msg('m0', 100),
        ],
      },
    ]
    const out = mergeHistory([], responses)
    expect(ids(out)).toEqual(['m0', 'm1', 'ma', 'mb', 'm3'])
  })

  it('maxPerRoom=3：合并后 5 条 → 保留最后 3 条（丢最旧）', () => {
    const existing = [msg('e1', 100), msg('e2', 300)]
    const responses = [{ messages: [msg('r1', 200), msg('r2', 400), msg('r3', 500)] }]
    const out = mergeHistory(existing, responses, { maxPerRoom: 3 })
    expect(ids(out)).toEqual(['e2', 'r2', 'r3'])
  })

  it('空 responses → existing 原样返回（新数组引用，不修改输入）', () => {
    const existing = [msg('e1', 100), msg('e2', 200)]
    const snapshot = JSON.parse(JSON.stringify(existing))
    const out = mergeHistory(existing, [])
    expect(out).toEqual(snapshot)
    expect(out).not.toBe(existing)
    expect(existing).toEqual(snapshot)
  })

  it('纯函数：合并不修改 existing 与 responses 输入', () => {
    const existing = [msg('e1', 100)]
    const responses = [{ messages: [msg('e1', 100), msg('r1', 50)] }, { messages: [msg('r1', 50)] }]
    const snapshot = JSON.parse(JSON.stringify({ existing, responses }))
    mergeHistory(existing, responses, { maxPerRoom: 1 })
    expect(JSON.parse(JSON.stringify({ existing, responses }))).toEqual(snapshot)
  })

  it('existing 优先：同 id 时保留 existing 版本', () => {
    const existing = [msg('a', 100, { text: 'cache' })]
    const responses = [
      { messages: [msg('a', 100, { text: 'net' })] },
      { messages: [msg('a', 100, { text: 'net' })] },
    ]
    const out = mergeHistory(existing, responses)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('cache')
  })

  it('默认 maxPerRoom=500 时不截断小规模合并', () => {
    const responses = [{ messages: [msg('r1', 1), msg('r2', 2)] }]
    const out = mergeHistory([], responses)
    expect(ids(out)).toEqual(['r1', 'r2'])
  })
})

import fs from 'node:fs'
import path from 'node:path'

describe('恶意/损坏 history 帧硬化', () => {
  it('跳过 null、数组、缺字符串 id 的条目，不抛', () => {
    const responses = [{
      messages: [
        null, 42, 'x', [], { id: 7, text: 'bad' },
        { id: 'ok1', ts: 1, text: 'good' },
        { id: 'ok1', ts: 1, text: 'dup' },
      ],
    }]
    const out = mergeHistory([null, { id: 'old', ts: 0, text: 'old' }], responses)
    expect(out.map((m) => m.id)).toEqual(['old', 'ok1'])
  })
})

describe('P0 搬包：跨侧可达性（Review Focus 5）', () => {
  it('core 包出口提供 mergeHistory', async () => {
    const core = await import('kuoluosaigai-bot-core')
    expect(typeof core.mergeHistory).toBe('function')
  })

  // 单一实现的保证走文件系统，不依赖打包器的模块实例同一性（R2）：
  // 老路径一旦消失，就不可能存在"src 侧还有一份在跑"的分叉。
  it('src/chat/historyMerge.js 已不存在（杜绝两份实现漂移，spec A8）', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), 'src/chat/historyMerge.js'))).toBe(false)
  })
})
