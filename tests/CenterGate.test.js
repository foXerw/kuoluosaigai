import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CenterGate from '../src/components/CenterGate.vue'

describe('CenterGate', () => {
  it('renders label and emits enter on click', async () => {
    const wrapper = mount(CenterGate, { props: { color: '#39ff14' } })
    expect(wrapper.text()).toContain('进入聊天室')
    await wrapper.trigger('click')
    expect(wrapper.emitted('enter')).toBeTruthy()
  })
})
