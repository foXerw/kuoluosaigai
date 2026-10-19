import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RulesModal from '../src/components/RulesModal.vue'
import { RULES_SECTIONS } from '../src/chat/rulesContent'

describe('RulesModal', () => {
  it('逐节渲染：节数与 RULES_SECTIONS 一致，标题与每行文案在场', () => {
    const w = mount(RulesModal)
    const secs = w.findAll('.rules__section')
    expect(secs).toHaveLength(RULES_SECTIONS.length)
    RULES_SECTIONS.forEach((sec, i) => {
      expect(secs[i].text()).toContain(sec.title)
      for (const line of sec.lines) {
        expect(secs[i].text()).toContain(line)
      }
    })
  })

  it('关键串渲染可见：100/200/500/280/NO SUCH ROOM/世界末日/[a-z0-9]', () => {
    const text = mount(RulesModal).text()
    for (const k of ['100', '200', '500', '280', 'NO SUCH ROOM', '世界末日', '[a-z0-9]']) {
      expect(text).toContain(k)
    }
  })

  it('✕ click → emit close', async () => {
    const w = mount(RulesModal)
    await w.find('.rules__close').trigger('click')
    expect(w.emitted('close')).toEqual([[]])
  })

  it('头部标题在场，正文区可内滚（小屏由 .rules__body 滚动）', () => {
    const w = mount(RulesModal)
    expect(w.find('.rules__top').text()).toContain('RULES')
    expect(w.find('.rules__body').exists()).toBe(true)
  })
})
