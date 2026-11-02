import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import fs from 'node:fs'
import path from 'node:path'
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

  // 版本刷新守卫：连 v2 聊天室 / v3 多房间 / BOT DECK 三轮都忘了改主页版本号，
  // 从此把开机序列的 vX.Y 和 package.json 钉在一起——只改一处就红。
  it('开机序列版本号与 package.json 的 major.minor 一致', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
    wrapper = mount(BootSequence, { props: { reducedMotion: true } })
    const m = /v(\d+)\.(\d+)/.exec(wrapper.text())
    expect(m, '开机序列首行必须带 vX.Y 版本号').toBeTruthy()
    const [maj, min] = String(pkg.version).split('.')
    expect(`${m[1]}.${m[2]}`).toBe(`${maj}.${min}`)
  })
})
