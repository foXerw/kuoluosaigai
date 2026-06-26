import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScanlineWipe from '../src/components/ScanlineWipe.vue'

describe('ScanlineWipe', () => {
  it('renders the scanline bar', () => {
    const wrapper = mount(ScanlineWipe)
    expect(wrapper.find('.wipe__line').exists()).toBe(true)
  })

  it('emits done when the bar animation ends', async () => {
    const wrapper = mount(ScanlineWipe)
    await wrapper.find('.wipe__line').trigger('animationend')
    expect(wrapper.emitted('done')).toBeTruthy()
    expect(wrapper.emitted('done')).toHaveLength(1)
  })
})
