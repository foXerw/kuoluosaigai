<template>
  <a-modal
    :open="open"
    :centered="true"
    :footer="null"
    :closable="true"
    class="chat-placeholder"
    @cancel="$emit('close')"
  >
    <div class="chat-placeholder__body">
      <p class="chat-placeholder__title glow">频道尚未开放</p>
      <p class="chat-placeholder__sub">channel offline — coming soon</p>
    </div>
  </a-modal>
</template>

<script>
import { Modal } from 'ant-design-vue'

export default {
  name: 'ChatPlaceholder',
  components: { 'a-modal': Modal },
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['close'],
}
</script>

<style scoped>
.chat-placeholder__body {
  text-align: center;
  padding: 24px 8px;
  font-family: var(--app-mono);
  color: var(--app-color);
}
.chat-placeholder__title { font-size: 18px; letter-spacing: 2px; margin: 0 0 8px; }
.chat-placeholder__sub { font-size: 12px; opacity: 0.6; margin: 0; }
</style>
