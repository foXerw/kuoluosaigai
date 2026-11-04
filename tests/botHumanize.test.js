import { describe, it, expect } from 'vitest'
import {
  SILENCE_TOKEN,
  HUMANIZE_DEFAULTS,
  isSilence,
  sampleTargetLength,
  truncateToTarget,
  applyTone,
  splitSegments,
  planReply,
} from '../packages/bot-core/humanize.js'

// 逐值弹出 rng：序列耗尽即抛——强制每个用例精确记账每次掷骰。
function seq(vals) {
  let i = 0
  return () => {
    if (i >= vals.length) throw new Error(`rng 序列耗尽（第 ${i + 1} 次调用）`)
    return vals[i++]
  }
}
describe('isSilence', () => {
  it('识别全部约定变体（含空白）', () => {
    for (const s of ['[沉默]', ' 【沉默】 ', '（沉默）', '(沉默)', '沉默']) {
      expect(isSilence(s)).toBe(true)
    }
  })

  it('非沉默/超长/非字符串不误判', () => {
    expect(isSilence('我不想沉默')).toBe(false)
    expect(isSilence('沉默是今晚的康桥')).toBe(false)
    expect(isSilence('[沉默] 然后呢')).toBe(false)
    expect(isSilence('')).toBe(false)
    expect(isSilence(null)).toBe(false)
    expect(isSilence(42)).toBe(false)
  })

  it('SILENCE_TOKEN 是 [沉默]', () => {
    expect(SILENCE_TOKEN).toBe('[沉默]')
  })
})

describe('sampleTargetLength', () => {
  it('四档边界都落在配置区间内', () => {
    expect(sampleTargetLength(seq([0, 0]))).toBe(2)
    expect(sampleTargetLength(seq([0.4, 0]))).toBe(5)
    expect(sampleTargetLength(seq([0.7, 0]))).toBe(11)
    expect(sampleTargetLength(seq([0.99, 0]))).toBe(19)
  })

  it('上端由 rng≈1 钳到区间上界', () => {
    expect(sampleTargetLength(seq([0, 0.999]))).toBe(4)
    expect(sampleTargetLength(seq([0.99, 0.999]))).toBe(30)
  })

  it('默认 rng 产出恒在 2–30', () => {
    for (let i = 0; i < 200; i++) {
      const n = sampleTargetLength()
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(30)
    }
  })
})

describe('truncateToTarget', () => {
  it('不超 target+slack 且按码点截断（emoji 不被劈开）', () => {
    const long = '😀'.repeat(20)
    const out = truncateToTarget(long, 2)
    expect(Array.from(out).length).toBeLessThanOrEqual(8)
    expect(out).not.toContain('�')
  })

  it('不超长时原样返回', () => {
    expect(truncateToTarget('短句', 10)).toBe('短句')
  })

  it('优先在标点处收尾', () => {
    const text = '一二三四五六七八九十。后面还有很多内容'
    const out = truncateToTarget(text, 6)
    expect(out).toBe('一二三四五六七八九十。')
    expect(Array.from(out).length).toBeLessThanOrEqual(12)
  })

  it('非字符串 → 空串；target 非有限数按默认值兜底', () => {
    expect(truncateToTarget(null, 8)).toBe('')
    expect(truncateToTarget('一二三四五六七八九十', NaN)).toBe('一二三四五六七八九十')
  })
})

describe('applyTone', () => {
  it('句尾句号按概率去掉（rng 命中）', () => {
    expect(applyTone('好的。', seq([0.5, 0.5]))).toBe('好的')
  })

  it('句号保留（rng 未命中）', () => {
    expect(applyTone('好的。', seq([0.5, 0.9]))).toBe('好的。')
  })

  it('概率追加语气括号，且不叠加在已有括号后', () => {
    expect(applyTone('好的', seq([0.01, 0]))).toBe('好的（笑）')
    expect(applyTone('好的（笑）', seq([0.01]))).toBe('好的（笑）')
  })

  it('空/非字符串原样返回空串且不掷骰', () => {
    expect(applyTone('', seq([]))).toBe('')
    expect(applyTone(null, seq([]))).toBe('')
  })
})

describe('splitSegments', () => {
  it('按句末标点拆分；过短碎片（<3 码点）并入邻段', () => {
    expect(splitSegments('好。行！那就这样？')).toEqual(['好。行！', '那就这样？'])
  })

  it('足够长的相邻短句保持独立', () => {
    expect(splitSegments('好的。行吧！那就这样？')).toEqual(['好的。', '行吧！', '那就这样？'])
  })

  it('无标点 → 单段', () => {
    expect(splitSegments('没有标点的一段话')).toEqual(['没有标点的一段话'])
  })

  it('省略号是一处边界，不会拆出孤立的「…」', () => {
    expect(splitSegments('啊……好吧')).toEqual(['啊……好吧'])
    expect(splitSegments('这是真的……我不信。')).toEqual(['这是真的……', '我不信。'])
  })

  it('连续超短句合并，不产生刷屏微消息', () => {
    expect(splitSegments('好。行。嗯。对。')).toEqual(['好。行。嗯。对。'])
  })

  it('超过 max 时尾部并入最后一段', () => {
    expect(splitSegments('第一句。第二句。第三句。第四句。第五句。第六句。', 4))
      .toEqual(['第一句。', '第二句。', '第三句。', '第四句。第五句。第六句。'])
  })

  it('换行也作为段边界', () => {
    expect(splitSegments('第一行\n第二行')).toEqual(['第一行', '第二行'])
  })

  it('空串 → 空数组', () => {
    expect(splitSegments('')).toEqual([])
    expect(splitSegments(null)).toEqual([])
  })
})

describe('planReply', () => {
  it('沉默标记 → silent 且不掷骰', () => {
    expect(planReply('[沉默]', { rng: seq([]), targetLen: 8 })).toEqual({ silent: true, segments: [] })
    expect(planReply(' ', { rng: seq([]), targetLen: 8 })).toEqual({ silent: true, segments: [] })
  })

  it('强制分段：标点拆开、逐段做语气处理', () => {
    const out = planReply('好的。行吧！那就这样？', {
      rng: seq([0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      targetLen: 20,
      allowSegments: true,
    })
    expect(out).toEqual({ silent: false, segments: ['好的', '行吧！', '那就这样？'] })
  })

  it('强制不分段：一条整句', () => {
    const out = planReply('好。行！那就这样？', {
      rng: seq([0.9, 0.5, 0.5]),
      targetLen: 20,
      allowSegments: true,
    })
    expect(out).toEqual({ silent: false, segments: ['好。行！那就这样？'] })
  })

  it('allowSegments=false 时连分段骰都不掷', () => {
    const out = planReply('好。行！', {
      rng: seq([0.5, 0.5]),
      targetLen: 20,
      allowSegments: false,
    })
    expect(out.segments).toHaveLength(1)
  })

  it('长度目标二次截断生效', () => {
    const out = planReply('一二三四五六七八九十十一十二十三', {
      rng: seq([0.5, 0.5]), // 无标点 → 单段；括号不中；句号不中
      targetLen: 6,
      allowSegments: false,
    })
    expect(Array.from(out.segments[0]).length).toBeLessThanOrEqual(12)
  })
})

describe('HUMANIZE_DEFAULTS', () => {
  it('关键常量与 spec 一致', () => {
    expect(HUMANIZE_DEFAULTS.maxSegments).toBe(4)
    expect(HUMANIZE_DEFAULTS.segmentGapMs).toEqual([350, 1200])
    expect(HUMANIZE_DEFAULTS.segmentProb).toBe(0.5)
    expect(HUMANIZE_DEFAULTS.drowsyThinkFactor).toBe(2)
    expect(HUMANIZE_DEFAULTS.drowsyMaxTarget).toBe(8)
  })
})
