import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTypewriter } from '../src/composables/useTypewriter'

describe('useTypewriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('types lines in order and signals done', async () => {
    const { lines, done, typeSequence } = useTypewriter()
    const p = typeSequence(['ab', 'cd'], { charDelay: 10, lineDelay: 10 })
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(lines.value).toEqual(['ab', 'cd'])
    expect(done.value).toBe(true)
  })

  it('invokes onAllDone after sequence', async () => {
    const { typeSequence } = useTypewriter()
    let finished = false
    const p = typeSequence(['x'], {
      charDelay: 5,
      lineDelay: 5,
      onAllDone: () => { finished = true },
    })
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(finished).toBe(true)
  })
})
