import { describe, it, expect } from 'vitest'
import { RULES_SECTIONS } from '../src/chat/rulesContent'

const FLAT = RULES_SECTIONS.map((s) => [s.title, ...s.lines].join('\n')).join('\n')

describe('RULES_SECTIONS 结构', () => {
  it('非空数组，每节形如 {title, lines[]}，行非空白', () => {
    expect(Array.isArray(RULES_SECTIONS)).toBe(true)
    expect(RULES_SECTIONS.length).toBeGreaterThanOrEqual(7)
    for (const sec of RULES_SECTIONS) {
      expect(typeof sec.title).toBe('string')
      expect(sec.title.trim().length).toBeGreaterThan(0)
      expect(Array.isArray(sec.lines)).toBe(true)
      expect(sec.lines.length).toBeGreaterThan(0)
      for (const line of sec.lines) {
        expect(typeof line).toBe('string')
        expect(line.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('RULES_SECTIONS 内容（spec §6 大纲逐条 + §7 护栏表数值）', () => {
  it('房间 = 6 位 [a-z0-9] ID，创建即永存，不可删除不可改名', () => {
    expect(FLAT).toContain('6 位')
    expect(FLAT).toContain('[a-z0-9]')
    expect(FLAT).toMatch(/永存|永生/)
    expect(FLAT).toContain('无法删除')
    expect(FLAT).toContain('无法改名')
  })

  it('服务器无房间目录、不提供搜索，ID 即门票', () => {
    expect(FLAT).toContain('目录')
    expect(FLAT).toContain('搜索')
    expect(FLAT).toContain('门票')
  })

  it('记录不经服务器存储，活在在场者浏览器；新人向在场者索取；最后一人离开即消失', () => {
    expect(FLAT).toContain('浏览器')
    expect(FLAT).toContain('向在场者索取')
    expect(FLAT).toMatch(/最后一人[^。]*消失/)
  })

  it('未知 ID 拒绝：NO SUCH ROOM；乱猜撞墙：SLOW DOWN', () => {
    expect(FLAT).toContain('NO SUCH ROOM')
    expect(FLAT).toContain('SLOW DOWN')
  })

  it('护栏数值逐项在场：100 人/房、200 条/份、20 房×500 条、10 条/分钟、280 字', () => {
    expect(FLAT).toContain('100')
    expect(FLAT).toContain('200')
    expect(FLAT).toMatch(/20 房 ?× ?500/)
    expect(FLAT).toMatch(/10 条\/分钟/)
    expect(FLAT).toContain('280')
  })

  it('反脚本双限速：输错 ID 10 次/分钟、建房 5 间/分钟，并点明反脚本', () => {
    expect(FLAT).toMatch(/输错[^。]*10 次\/分钟/)
    expect(FLAT).toMatch(/建房[^。]*5 间\/分钟/)
    expect(FLAT).toContain('反脚本')
  })

  it('防伪警告：≥2 人佐证、单人房无从对质、街头传闻', () => {
    expect(FLAT).toMatch(/≥ ?2 人/)
    expect(FLAT).toContain('单人房')
    expect(FLAT).toContain('无从对质')
    expect(FLAT).toContain('街头传闻')
  })

  it('世界末日彩蛋：删 rooms.log', () => {
    expect(FLAT).toContain('rooms.log')
    expect(FLAT).toContain('世界末日')
  })
})
