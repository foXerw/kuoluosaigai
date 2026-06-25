import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { CHANNELS } from '../src/theme/channels'

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

describe('App channel theming', () => {
  beforeEach(() => sessionStorage.clear())

  it('sets --app-color on documentElement to the picked channel color', () => {
    const magenta = CHANNELS.find((c) => c.prefix === 'MAGENTA')
    sessionStorage.setItem('kuoluosaigai:channel', magenta.freq)
    mount(App, {
      global: {
        stubs: {
          'a-config-provider': { template: '<div><slot /></div>' },
          BootSequence: true,
          ChannelShell: true,
          ChatPlaceholder: true,
        },
      },
    })
    expect(document.documentElement.style.getPropertyValue('--app-color')).toBe(magenta.color)
    expect(document.documentElement.style.getPropertyValue('--app-glow')).toBe(magenta.glow)
  })
})
