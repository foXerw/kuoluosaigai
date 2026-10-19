import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RoomDrawer from '../src/components/RoomDrawer.vue'
import { PUBLIC_ROOM_IDS } from '../src/theme/channels'

function mountDrawer(props = {}) {
  return mount(RoomDrawer, {
    props: { rooms: [], current: '', counts: {}, notice: '', ...props },
  })
}

function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

function stubExecCommand(result = true) {
  const fn = vi.fn(() => result)
  const prev = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true })
  return {
    fn,
    restore() {
      delete document.execCommand
      if (prev) Object.defineProperty(document, 'execCommand', prev)
    },
  }
}

function forceNoClipboard() {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
}

afterEach(() => {
  delete navigator.clipboard // 只删测试自设的 own 属性，恢复环境原状
  vi.useRealTimers()
})

describe('RoomDrawer', () => {
  // ---------- 断言清单逐条 ----------

  it('rooms=PUBLIC_ROOM_IDS 时渲染 4 行公共房名（SETSUBUN…）', () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS })
    const rows = w.findAll('.drawer__row--public')
    expect(rows).toHaveLength(4)
    const text = w.text()
    expect(text).toContain('SETSUBUN')
    expect(text).toContain('NEBULA')
    expect(text).toContain('MAGENTA')
    expect(text).toContain('AMBER')
  })

  it('counts={nebula:3} → nebula 行显 3，其余 --', () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS, counts: { nebula: 3 } })
    const rows = w.findAll('.drawer__row--public')
    expect(rows[1].text()).toContain('NEBULA')
    expect(rows[1].text()).toContain('3')
    expect(rows[0].text()).toContain('--')
    expect(rows[2].text()).toContain('--')
    expect(rows[3].text()).toContain('--')
  })

  it('私有行 abc123：有 ⧉ 复制钮与 ✕ 删除钮', () => {
    const w = mountDrawer({ rooms: [...PUBLIC_ROOM_IDS, 'abc123'] })
    const priv = w.findAll('.drawer__row--private')
    expect(priv).toHaveLength(1)
    expect(priv[0].text()).toContain('abc123')
    expect(priv[0].find('.drawer__copy').exists()).toBe(true)
    expect(priv[0].find('.drawer__remove').exists()).toBe(true)
  })

  it('私有行 ✕ emit remove(abc123)', async () => {
    const w = mountDrawer({ rooms: [...PUBLIC_ROOM_IDS, 'abc123'] })
    await w.find('.drawer__remove').trigger('click')
    expect(w.emitted('remove')).toEqual([['abc123']])
  })

  it('点私有行 emit join(abc123)', async () => {
    const w = mountDrawer({ rooms: [...PUBLIC_ROOM_IDS, 'abc123'] })
    await w.find('.drawer__row--private').trigger('click')
    expect(w.emitted('join')).toEqual([['abc123']])
  })

  it('公共行无 ✕', () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS })
    expect(w.findAll('.drawer__row--public').every((r) => !r.find('.drawer__remove').exists())).toBe(true)
    expect(w.findAll('.drawer__remove')).toHaveLength(0)
  })

  it('输入 zzzzzz 提交 → emit join(zzzzzz)，输入清空', async () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS })
    await w.find('input').setValue('zzzzzz')
    await w.find('form').trigger('submit')
    expect(w.emitted('join')).toEqual([['zzzzzz']])
    expect(w.find('input').element.value).toBe('')
  })

  it('[+ NEW] click → emit create', async () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS })
    await w.find('.drawer__new').trigger('click')
    expect(w.emitted('create')).toEqual([[]])
  })

  it("notice='NO SUCH ROOM' → 出现报错文案", () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS, notice: 'NO SUCH ROOM' })
    expect(w.find('.drawer__notice').exists()).toBe(true)
    expect(w.text()).toContain('NO SUCH ROOM')
  })

  it("notice='' → 不渲染报错行", () => {
    const w = mountDrawer({ rooms: PUBLIC_ROOM_IDS, notice: '' })
    expect(w.find('.drawer__notice').exists()).toBe(false)
    expect(w.text()).not.toContain('NO SUCH ROOM')
  })

  // ---------- 契约补充：current 标记 / trim / 空输入 ----------

  it('current 房间行带 is-current 标记', () => {
    const w = mountDrawer({ rooms: [...PUBLIC_ROOM_IDS, 'abc123'], current: 'nebula' })
    const marked = w.findAll('.drawer__row.is-current')
    expect(marked).toHaveLength(1)
    expect(marked[0].text()).toContain('NEBULA')
  })

  it('输入两侧空白被 trim 后再 emit join', async () => {
    const w = mountDrawer({ rooms: [] })
    await w.find('input').setValue('  zzzzzz  ')
    await w.find('form').trigger('submit')
    expect(w.emitted('join')).toEqual([['zzzzzz']])
  })

  it('空/纯空白输入提交不 emit join', async () => {
    const w = mountDrawer({ rooms: [] })
    await w.find('input').setValue('   ')
    await w.find('form').trigger('submit')
    expect(w.emitted('join')).toBeFalsy()
    expect(w.find('input').element.value).toBe('   ') // 未提交成功则不清空
  })

  // ---------- 复制：剪贴板、COPIED 计时、防重复、兜底、卸载清理 ----------

  it('点 ⧉：clipboard.writeText(id)，按钮 1s 内显示 COPIED，到期恢复 ⧉', async () => {
    vi.useFakeTimers()
    const writeText = stubClipboard()
    const w = mountDrawer({ rooms: [...PUBLIC_ROOM_IDS, 'abc123'] })
    const copyBtn = () => w.find('.drawer__copy')
    await copyBtn().trigger('click')
    expect(writeText).toHaveBeenCalledWith('abc123')
    expect(copyBtn().text()).toBe('COPIED')
    vi.advanceTimersByTime(1000)
    await w.vm.$nextTick()
    expect(copyBtn().text()).toBe('⧉')
    w.unmount()
  })

  it('COPIED 窗口内重复点击不再次复制', async () => {
    vi.useFakeTimers()
    const writeText = stubClipboard()
    const w = mountDrawer({ rooms: ['abc123'] })
    await w.find('.drawer__copy').trigger('click')
    await w.find('.drawer__copy').trigger('click')
    await w.find('.drawer__copy').trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('点 ⧉ 不会误触整行的 join', async () => {
    vi.useFakeTimers()
    stubClipboard()
    const w = mountDrawer({ rooms: ['abc123'] })
    await w.find('.drawer__copy').trigger('click')
    expect(w.emitted('join')).toBeFalsy()
    w.unmount()
  })

  it('navigator.clipboard 缺失时走 execCommand 兜底并显示 COPIED', async () => {
    vi.useFakeTimers()
    forceNoClipboard()
    const exec = stubExecCommand(true)
    try {
      const w = mountDrawer({ rooms: ['abc123'] })
      await w.find('.drawer__copy').trigger('click')
      expect(exec.fn).toHaveBeenCalledWith('copy')
      expect(w.find('.drawer__copy').text()).toBe('COPIED')
      w.unmount()
    } finally {
      exec.restore()
    }
  })

  it('兜底 execCommand 抛错：不显示 COPIED 且不泄漏隐藏 textarea', async () => {
    vi.useFakeTimers()
    forceNoClipboard()
    const exec = stubExecCommand()
    exec.fn.mockImplementation(() => {
      throw new Error('not implemented')
    })
    try {
      const w = mountDrawer({ rooms: ['abc123'] })
      await w.find('.drawer__copy').trigger('click')
      expect(w.find('.drawer__copy').text()).toBe('⧉')
      expect(document.querySelectorAll('textarea')).toHaveLength(0)
      w.unmount()
    } finally {
      exec.restore()
    }
  })

  it('卸载清除 COPIED 计时器', async () => {
    vi.useFakeTimers()
    stubClipboard()
    const w = mountDrawer({ rooms: ['abc123'] })
    await w.find('.drawer__copy').trigger('click')
    expect(vi.getTimerCount()).toBe(1)
    w.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
