<template>
  <div class="boot" @click="onClick">
    <div class="boot__log">
      <p v-for="(l, i) in lines" :key="i" class="boot__line"><span class="boot__prompt">&gt;</span> {{ l }}</p>
      <p v-if="!done" class="boot__current glow">{{ currentText }}<span class="boot__cursor">▋</span></p>
    </div>
    <button v-if="done" type="button" class="boot__hint glow">[ press ENTER to join ]</button>
  </div>
</template>

<script>
import { useTypewriter } from '../composables/useTypewriter'

const SEQUENCE = [
  '[BOOT] kuoluosaigai channel daemon v0.1',
  '[OK] handshake',
  '[FREQ] tuning...',
  '[READY] press ENTER to join.',
]

export default {
  name: 'BootSequence',
  props: {
    reducedMotion: { type: Boolean, default: false },
  },
  emits: ['ready'],
  setup(props) {
    const { lines, currentText, done, typeSequence } = useTypewriter()
    if (props.reducedMotion) {
      lines.value.push(...SEQUENCE)
      done.value = true
    }
    return { lines, currentText, done, typeSequence, SEQUENCE }
  },
  async mounted() {
    window.addEventListener('keydown', this.onKey)
    if (this.reducedMotion) return
    await this.typeSequence(SEQUENCE, { charDelay: 24, lineDelay: 220 })
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey)
  },
  methods: {
    onKey(e) {
      if (e.key !== 'Enter') return
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      this.maybeReady()
    },
    onClick() {
      this.maybeReady()
    },
    maybeReady() {
      if (!this.done) return
      this.$emit('ready')
    },
  },
}
</script>

<style scoped>
.boot {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  padding: 0 8vw;
}
.boot__log { font-size: 14px; line-height: 1.8; }
.boot__prompt { margin-right: 8px; opacity: 0.7; }
.boot__cursor { animation: blink 1s steps(1) infinite; margin-left: 2px; }
.boot__hint {
  margin-top: 24px;
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--app-color);
  font-family: var(--app-mono);
  padding: 0;
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
