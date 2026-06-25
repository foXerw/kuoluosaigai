import { ref } from 'vue'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useTypewriter() {
  const lines = ref([])
  const currentText = ref('')
  const done = ref(false)

  async function typeSequence(sequence, opts = {}) {
    const { charDelay = 24, lineDelay = 220, onLineDone, onAllDone } = opts
    done.value = false
    lines.value = []
    for (const line of sequence) {
      currentText.value = ''
      for (const ch of line) {
        currentText.value += ch
        await delay(charDelay)
      }
      lines.value.push(line)
      currentText.value = ''
      onLineDone?.(line)
      await delay(lineDelay)
    }
    done.value = true
    onAllDone?.()
  }

  return { lines, currentText, done, typeSequence }
}
