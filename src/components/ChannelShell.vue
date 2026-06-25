<template>
  <div class="shell" :style="{ '--app-color': channel.color, '--app-glow': channel.glow }">
    <div class="shell__bg" aria-hidden="true" />
    <header class="shell__top">
      <span class="shell__codename glow">{{ codename }}</span>
      <span class="shell__freq">FREQ {{ channel.freq }}</span>
    </header>
    <main class="shell__center">
      <CenterGate :color="channel.color" @enter="$emit('enter')" />
    </main>
    <footer class="shell__status">
      <span class="shell__online">● {{ online }} online</span>
      <span class="shell__clock">{{ clock }}</span>
      <button class="shell__reshuffle" @click="$emit('reshuffle')">🔀 RESHUFFLE</button>
    </footer>
  </div>
</template>

<script>
import CenterGate from './CenterGate.vue'

export default {
  name: 'ChannelShell',
  components: { CenterGate },
  props: {
    channel: { type: Object, required: true },
  },
  emits: ['enter', 'reshuffle'],
  data() {
    return {
      online: 1 + Math.floor(Math.random() * 99),
      clock: '',
      timer: null,
    }
  },
  computed: {
    codename() {
      return `${this.channel.prefix}-${this.channel.freq}`
    },
  },
  mounted() {
    this.tick()
    this.timer = setInterval(this.tick, 1000)
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer)
  },
  methods: {
    tick() {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      this.clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    },
  },
}
</script>

<style scoped>
.shell {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: var(--app-color);
}
.shell__top, .shell__status {
  display: flex;
  justify-content: space-between;
  padding: 16px 24px;
  font-size: 12px;
  letter-spacing: 2px;
  position: relative;
  z-index: 3;
}
.shell__center {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  z-index: 3;
}
.shell__reshuffle {
  background: none;
  border: 1px solid var(--app-color);
  color: var(--app-color);
  font-family: var(--app-mono);
  padding: 4px 10px;
  cursor: pointer;
}
</style>
