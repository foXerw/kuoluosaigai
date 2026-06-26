import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BootSequence from '../src/components/BootSequence.vue'

function keydown(key, mods = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...mods }))
}

describe('BootSequence', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount?.()
    vi.useRealTimers()
  })

  it('renders all lines under reduced motion and emits ready on click', async () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    expect(wrapper.findAll('.boot__line')).toHaveLength(4)
    expect(wrapper.find('button.boot__hint').exists()).toBe(true)
    await wrapper.find('.boot').trigger('click')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })

  it('emits ready on Enter key when done', () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    keydown('Enter')
    expect(wrapper.emitted('ready')).toBeTruthy()
  })

  it('ignores Enter combined with modifier keys', () => {
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    keydown('Enter', { ctrlKey: true })
    keydown('Enter', { shiftKey: true })
    keydown('Enter', { metaKey: true })
    keydown('Enter', { altKey: true })
    expect(wrapper.emitted('ready')).toBeFalsy()
  })

  it('does not emit ready before the typewriter finishes', () => {
    vi.useFakeTimers()
    wrapper = mount(BootSequence, { props: { reducedMotion: false } })
    keydown('Enter')
    expect(wrapper.emitted('ready')).toBeFalsy()
  })
})
