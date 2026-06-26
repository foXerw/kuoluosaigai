<template>
  <div class="wipe" aria-hidden="true">
    <div class="wipe__line" @animationend="$emit('done')"></div>
  </div>
</template>

<script>
export default {
  name: 'ScanlineWipe',
  emits: ['done'],
}
</script>

<style scoped>
.wipe {
  position: absolute;
  inset: 0;
  z-index: 50;
  pointer-events: none;
}
.wipe__line {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: var(--app-color);
  box-shadow: 0 0 16px 4px var(--app-color);
  animation: wipeSweep var(--wipe-ms) ease-in;
}
@keyframes wipeSweep {
  from { top: 0; }
  to { top: 100%; }
}
</style>
