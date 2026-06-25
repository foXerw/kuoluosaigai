import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'

describe('App', () => {
  beforeEach(() => sessionStorage.clear())

  const stubs = {
    'a-config-provider': { template: '<div><slot /></div>' },
    BootSequence: { template: '<div class="boot-stub" @click="$emit(\'ready\')" />', emits: ['ready'] },
    ChannelShell: true,
    ChatPlaceholder: true,
  }

  it('starts in boot phase then enters shell on ready', async () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    await wrapper.find('.boot-stub').trigger('click')
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('picks a channel on creation', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.vm.channel).toBeTruthy()
    expect(wrapper.vm.channel.freq).toMatch(/^\d{4}$/)
  })
})
