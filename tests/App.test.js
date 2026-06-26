import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { CHANNELS } from '../src/theme/channels'

describe('App', () => {
  beforeEach(() => sessionStorage.clear())

  const stubs = {
    'a-config-provider': { template: '<div><slot /></div>' },
    BootSequence: { template: '<div class="boot-stub" @click="$emit(\'ready\')" />', emits: ['ready'] },
    ScanlineWipe: { template: '<div class="wipe-stub" @click="$emit(\'done\')" />', emits: ['done'] },
    ChannelShell: true,
    ChatPlaceholder: true,
  }

  it('starts in boot phase with only BootSequence mounted', () => {
    const wrapper = mount(App, { global: { stubs } })
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    expect(wrapper.find('.wipe-stub').exists()).toBe(false)
  })

  it('enters wiping on ready: mounts ScanlineWipe, keeps boot, mounts shell', async () => {
    const wrapper = mount(App, { global: { stubs } })
    await wrapper.find('.boot-stub').trigger('click')
    expect(wrapper.find('.boot-stub').exists()).toBe(true)
    expect(wrapper.find('.wipe-stub').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('enters shell on wipe done: unmounts boot and wipe, keeps shell', async () => {
    const wrapper = mount(App, { global: { stubs } })
    await wrapper.find('.boot-stub').trigger('click')
    await wrapper.find('.wipe-stub').trigger('click')
    expect(wrapper.find('.boot-stub').exists()).toBe(false)
    expect(wrapper.find('.wipe-stub').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
  })

  it('skips wipe under reduced motion: ready goes straight to shell', async () => {
    const real = window.matchMedia
    window.matchMedia = () => ({
      matches: true, media: '', onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false },
    })
    try {
      const wrapper = mount(App, { global: { stubs } })
      await wrapper.find('.boot-stub').trigger('click')
      expect(wrapper.find('.wipe-stub').exists()).toBe(false)
      expect(wrapper.find('.boot-stub').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
    } finally {
      window.matchMedia = real
    }
  })

  it('falls back to shell via safety timeout if wipe animationend never fires', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(App, { global: { stubs } })
      await wrapper.find('.boot-stub').trigger('click')
      expect(wrapper.find('.wipe-stub').exists()).toBe(true)
      // do NOT click .wipe-stub; let the fallback fire
      vi.advanceTimersByTime(800)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wipe-stub').exists()).toBe(false)
      expect(wrapper.find('.boot-stub').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'ChannelShell' }).exists()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
