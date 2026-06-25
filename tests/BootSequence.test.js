import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BootSequence from '../src/components/BootSequence.vue'

describe('BootSequence', () => {
  it('renders all lines under reduced motion and emits ready on click', async () => {
    const wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    expect(wrapper.findAll('.boot__line')).toHaveLength(4)
    const btn = wrapper.find('.boot__enter')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })
})
