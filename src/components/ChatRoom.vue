<template>
  <div class="chat">
    <div class="chat__top">
      <span class="chat__chan">● CHANNEL // GLOBAL</span>
      <span class="chat__meta">{{ online }} online · {{ statusLabel }}</span>
      <button class="chat__close" @click="$emit('close')">✕</button>
    </div>

    <div v-if="!url" class="chat__offline">频道离线 · channel offline</div>

    <template v-else>
      <div ref="listEl" class="chat__msgs">
        <div v-for="(m, i) in messages" :key="i" class="chat__row">
          <span class="chat__time">{{ fmt(m.ts) }}</span>
          <template v-if="m.type === 'message'">
            <span v-if="m.badge" class="chat__badge">{{ m.badge }}</span>
            <span class="chat__nick">{{ m.nick }}</span>
            <span class="chat__body"> &gt; {{ m.text }}</span>
          </template>
          <span v-else class="chat__sys">{{ sysText(m) }}</span>
        </div>
      </div>
      <form class="chat__input" @submit.prevent="onSubmit">
        <span class="chat__prompt">&gt;</span>
        <input
          v-model="draft"
          class="chat__field"
          :disabled="status !== 'open'"
          :placeholder="status === 'open' ? '' : 'offline'"
        />
      </form>
    </template>
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'

function pad(n) {
  return String(n).padStart(2, '0')
}

export default {
  name: 'ChatRoom',
  props: {
    url: { type: String, default: '' },
    channel: { type: Object, default: null },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const badge = props.channel?.prefix || ''
    const chat = useChat(props.url, badge)
    const draft = ref('')
    const listEl = ref(null)

    const statusLabel = computed(() => {
      if (!props.url) return 'offline'
      return { connecting: 'connecting…', open: 'connected', closed: 'offline' }[chat.status.value] || 'offline'
    })

    function fmt(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function sysText(m) {
      if (m.type === 'join') return `${m.nick} joined`
      if (m.type === 'leave') return `${m.nick} left`
      if (m.type === 'rate') return 'rate limit — slow down'
      return ''
    }

    function onSubmit() {
      const text = draft.value.trim()
      if (!text || chat.status.value !== 'open') return
      chat.send(text)
      draft.value = ''
    }

    function onKey(e) {
      if (e.key === 'Escape') emit('close')
    }

    function scrollToBottom() {
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    }

    onMounted(() => {
      chat.connect()
      window.addEventListener('keydown', onKey)
      nextTick(scrollToBottom)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey)
    })
    watch(
      () => chat.messages.value.length,
      async () => {
        await nextTick()
        scrollToBottom()
      }
    )

    return {
      status: chat.status,
      nick: chat.nick,
      messages: chat.messages,
      online: chat.online,
      draft,
      listEl,
      statusLabel,
      fmt,
      sysText,
      onSubmit,
    }
  },
}
</script>

<style scoped>
.chat {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--app-bg, #0a0e0a);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  display: flex;
  flex-direction: column;
}
.chat__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #1f2a1f;
  font-size: 12px;
  letter-spacing: 1px;
}
.chat__meta {
  margin-left: auto;
  margin-right: 12px;
  opacity: 0.8;
}
.chat__close {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  cursor: pointer;
  padding: 2px 8px;
}
.chat__msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.6;
}
.chat__row {
  margin-bottom: 4px;
  word-break: break-word;
}
.chat__time {
  opacity: 0.4;
  margin-right: 8px;
}
.chat__badge {
  display: inline-block;
  border: 1px solid var(--app-color, #39ff14);
  padding: 0 4px;
  font-size: 10px;
  margin-right: 6px;
  opacity: 0.85;
}
.chat__nick {
  color: #7cfc7c;
}
.chat__sys {
  opacity: 0.5;
  font-style: italic;
}
.chat__offline {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  letter-spacing: 2px;
}
.chat__input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #1f2a1f;
}
.chat__prompt {
  opacity: 0.6;
}
.chat__field {
  flex: 1;
  background: #061006;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 13px;
  padding: 6px 10px;
  outline: none;
}
.chat__field:disabled {
  opacity: 0.4;
}
</style>
