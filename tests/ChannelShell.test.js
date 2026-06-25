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
})
