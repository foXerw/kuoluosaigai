import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ChannelShell from '../src/components/ChannelShell.vue'

const CHANNEL = { freq: '7741', prefix: 'SETSUBUN', color: '#39ff14', glow: '#39ff14' }

describe('ChannelShell', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
  })

  it('renders codename and freq', () => {
    wrapper = mount(ChannelShell, {
      props: { channel: CHANNEL },
      global: { stubs: { CenterGate: true } },
    })
    expect(wrapper.text()).toContain('SETSUBUN-7741')
    expect(wrapper.text()).toContain('FREQ 7741')
  })

  it('emits reshuffle on button click', async () => {
    wrapper = mount(ChannelShell, {
      props: { channel: CHANNEL },
      global: { stubs: { CenterGate: true } },
    })
    await wrapper.find('.shell__reshuffle').trigger('click')
    expect(wrapper.emitted('reshuffle')).toBeTruthy()
  })

  it('footer 有 BOT DECK 按钮，点击 emit("botdeck")', async () => {
    wrapper = mount(ChannelShell, {
      props: { channel: CHANNEL },
      global: { stubs: { CenterGate: true } },
    })
    const btn = wrapper.find('.shell__botdeck')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('BOT DECK')
    await btn.trigger('click')
    expect(wrapper.emitted('botdeck')).toBeTruthy()
    // 两按钮互不串线：BOT DECK 不应触发 reshuffle
    expect(wrapper.emitted('reshuffle')).toBeFalsy()
  })
})
