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

  it('passes the open prop through to a-modal', () => {
    const ModalStub = { name: 'a-modal', props: ['open'], template: '<div><slot /></div>' }

    const openWrapper = mount(ChatPlaceholder, {
      props: { open: true },
      global: { stubs: { 'a-modal': ModalStub } },
    })
    const openModal = openWrapper.findComponent({ name: 'a-modal' })
    expect(openModal.exists()).toBe(true)
    expect(openModal.props('open')).toBe(true)

    const closedWrapper = mount(ChatPlaceholder, {
      props: { open: false },
      global: { stubs: { 'a-modal': ModalStub } },
    })
    const closedModal = closedWrapper.findComponent({ name: 'a-modal' })
    expect(closedModal.exists()).toBe(true)
    expect(closedModal.props('open')).toBe(false)
  })

  it('emits close when a-modal fires cancel', async () => {
    const ModalStub = { name: 'a-modal', props: ['open'], template: '<div><slot /></div>' }
    const wrapper = mount(ChatPlaceholder, {
      props: { open: true },
      global: { stubs: { 'a-modal': ModalStub } },
    })
    const modal = wrapper.findComponent({ name: 'a-modal' })
    expect(modal.exists()).toBe(true)
    await modal.vm.$emit('cancel')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close').length).toBe(1)
  })
})
