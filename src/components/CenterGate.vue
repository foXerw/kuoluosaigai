<template>
  <button class="gate" :style="{ '--gate-color': color }" @click="$emit('enter')">
    <span class="gate__pulse" />
    <span class="gate__label glow">进入聊天室</span>
    <span class="gate__sub">ENTER CHANNEL</span>
  </button>
</template>

<script>
export default {
  name: 'CenterGate',
  props: {
    color: { type: String, default: '#39ff14' },
  },
  emits: ['enter'],
}
</script>

<style scoped>
.gate {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  background: none;
  border: 1px solid var(--gate-color);
  color: var(--gate-color);
  font-family: var(--app-mono);
  padding: 28px 48px;
  cursor: pointer;
}
.gate__label { font-size: 20px; letter-spacing: 2px; }
.gate__sub { font-size: 11px; opacity: 0.6; letter-spacing: 3px; }
.gate__pulse {
  position: absolute;
  inset: -1px;
  border: 1px solid var(--gate-color);
  animation: pulse 1.8s ease-in-out infinite;
  pointer-events: none;
}
.gate:hover { background: rgba(255, 255, 255, 0.04); }
</style>
