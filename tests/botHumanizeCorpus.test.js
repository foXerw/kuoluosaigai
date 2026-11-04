import { describe, it, expect } from 'vitest'
import { FEW_SHOT_EXAMPLES, FEW_SHOT_HEADER } from '../packages/bot-core/humanize-corpus.js'

// 语料来自公开 Tieba 语料库的短回复，只作 few-shot 风格示例。
// 这些不变量是「能安全进 system prompt」的底线：短、不重复、无链接/联系方式/PII。
describe('humanize-corpus（Tieba few-shot）', () => {
  it('条目数量在 30–60 之间', () => {
    expect(Array.isArray(FEW_SHOT_EXAMPLES)).toBe(true)
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(30)
    expect(FEW_SHOT_EXAMPLES.length).toBeLessThanOrEqual(60)
  })

  it('全部是 2–32 码点的非空字符串且无重复', () => {
    for (const s of FEW_SHOT_EXAMPLES) {
      expect(typeof s).toBe('string')
      expect(s.trim()).toBe(s)
      const n = Array.from(s).length
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(32)
    }
    expect(new Set(FEW_SHOT_EXAMPLES).size).toBe(FEW_SHOT_EXAMPLES.length)
  })

  it('不含链接、联系方式、长数字与换行', () => {
    for (const s of FEW_SHOT_EXAMPLES) {
      expect(s).not.toMatch(/https?:\/\/|www\.|\.(com|cn|net|org)\b/i)
      expect(s).not.toMatch(/@|qq|微信|vx|群号|私信/i)
      expect(s).not.toMatch(/\d{5,}/)
      expect(s).not.toMatch(/[\r\n]/)
    }
  })

  it('header 明确“学语气、不照抄”', () => {
    expect(FEW_SHOT_HEADER).toContain('学语气')
    expect(FEW_SHOT_HEADER).toContain('不要照抄')
  })
})
