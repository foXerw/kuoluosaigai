import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatPlaceholder from '../src/components/ChatPlaceholder.vue'

describe('ChatPlaceholder', () => {
  it('renders placeholder copy when open', () => {
    const wrapper = mount(ChatPlaceholder, {
      props: { open: true },
      global: {
        stubs: { 'a-modal': { template: '<div><slot /></div>' } },
      },
    })
    expect(wrapper.text()).toContain('频道尚未开放')
    expect(wrapper.text()).toContain('coming soon')
  })
})
