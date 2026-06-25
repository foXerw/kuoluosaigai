<template>
  <div class="boot">
    <div class="boot__log">
      <p v-for="(l, i) in lines" :key="i" class="boot__line"><span class="boot__prompt">&gt;</span> {{ l }}</p>
      <p v-if="!done" class="boot__current glow">{{ currentText }}<span class="boot__cursor">▋</span></p>
    </div>
    <button v-if="done" class="boot__enter glow" @click="$emit('ready')">[ press ENTER to join ]</button>
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
    if (this.reducedMotion) return
    await this.typeSequence(SEQUENCE, { charDelay: 24, lineDelay: 220 })
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
.boot__enter {
  margin-top: 24px;
  background: none;
  border: 1px solid var(--app-color);
  color: var(--app-color);
  font-family: var(--app-mono);
  padding: 10px 18px;
  cursor: pointer;
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
