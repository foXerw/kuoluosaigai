<template>
  <div class="chat">
    <div class="chat__top">
      <span class="chat__chan" :style="roomStyle">● ROOM {{ roomLabel }}</span>
      <button
        class="chat__btn chat__btn--rooms"
        :class="{ 'chat__btn--on': drawerOpen }"
        @click="toggleDrawer"
      >[ROOMS ▤]</button>
      <button
        class="chat__btn chat__btn--rules"
        :class="{ 'chat__btn--on': rulesOpen }"
        @click="toggleRules"
      >[RULES ?]</button>
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
      <p v-if="status !== 'open' && error" class="chat__err">连接失败（{{ error }}）—— 多半是代理/防火墙拦截了 WebSocket</p>
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

    <!-- R4：抽屉(90)/规则(110)必须挂在本组件根(100)的 stacking context 内，
         挂到 App 层会被整屏不透明的 .chat 盖住；v-if 保证关闭时不夺焦点 -->
    <RoomDrawer
      v-if="drawerOpen"
      class="chat__drawer"
      :class="{ 'chat__drawer--offline': status !== 'open' }"
      :rooms="rooms"
      :current="currentRoom ?? ''"
      :counts="counts"
      :notice="joinNotice"
      @join="join"
      @create="create"
      @remove="removeRoom"
    />
    <RulesModal v-if="rulesOpen" @close="rulesOpen = false" />
  </div>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'
import { channelByRoomId } from '../theme/channels'
import RoomDrawer from './RoomDrawer.vue'
import RulesModal from './RulesModal.vue'

function pad(n) {
  return String(n).padStart(2, '0')
}

// 色随房：把主题色写到 documentElement（公共房 = 频道色；私房/空 = 移除内联覆盖，
// 让 terminal.css :root 的默认绿 #39ff14 生效）
function applyThemeColor(color, glow) {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  if (color) {
    el.style.setProperty('--app-color', color)
    el.style.setProperty('--app-glow', glow || color)
  } else {
    el.style.removeProperty('--app-color')
    el.style.removeProperty('--app-glow')
  }
}

export default {
  name: 'ChatRoom',
  components: { RoomDrawer, RulesModal },
  props: {
    url: { type: String, default: '' },
    channel: { type: Object, default: null },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const chat = useChat(props.url, { badge: props.channel?.prefix || '' })
    const draft = ref('')
    const listEl = ref(null)
    const drawerOpen = ref(false)
    const rulesOpen = ref(false)

    // 顶栏 ROOM 指示：公共房显示频道 prefix + 频道色；私房显示原始 id（默认色）
    const roomLabel = computed(() => {
      const id = chat.currentRoom.value
      if (!id) return '--'
      return channelByRoomId(id)?.prefix || id
    })
    const roomStyle = computed(() => {
      const ch = channelByRoomId(chat.currentRoom.value)
      return ch ? { color: ch.color } : {}
    })

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

    // Esc 优先级（单一处理器，有序）：规则 → 抽屉 → 关闭聊天
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (rulesOpen.value) {
        rulesOpen.value = false
        return
      }
      if (drawerOpen.value) {
        drawerOpen.value = false
        return
      }
      emit('close')
    }

    function toggleDrawer() {
      drawerOpen.value = !drawerOpen.value
      // 仅在打开且在线时刷新在线数；离线打开静默（R5：不发任何帧）
      if (drawerOpen.value && chat.status.value === 'open') chat.refreshCounts()
    }

    function toggleRules() {
      rulesOpen.value = !rulesOpen.value
    }

    function scrollToBottom() {
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    }

    onMounted(() => {
      chat.connect(props.channel?.roomId) // open 后自动 join 落地房；重连时 useChat 优先回断开前的房间
      window.addEventListener('keydown', onKey)
      nextTick(scrollToBottom)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey)
      // 色随房收尾：卸载时恢复落地频道色（App.closeChat 也会显式恢复，双保险同值）
      applyThemeColor(props.channel?.color, props.channel?.glow)
    })
    // 色随房：切房即换主题色；私房/未入房移除内联覆盖回默认绿
    watch(chat.currentRoom, (roomId) => {
      const ch = roomId ? channelByRoomId(roomId) : null
      applyThemeColor(ch?.color, ch?.glow)
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
      error: chat.error,
      nick: chat.nick,
      currentRoom: chat.currentRoom,
      messages: chat.messages,
      online: chat.online,
      rooms: chat.rooms,
      counts: chat.counts,
      joinNotice: chat.joinNotice,
      cache: chat.cache, // 集成测试校验用（removeRoom 后 cache.get 为空）；模板不消费
      draft,
      listEl,
      drawerOpen,
      rulesOpen,
      roomLabel,
      roomStyle,
      statusLabel,
      fmt,
      sysText,
      onSubmit,
      toggleDrawer,
      toggleRules,
      join: chat.join,
      create: chat.create,
      removeRoom: chat.removeRoom,
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
.chat__btn {
  background: none;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 11px;
  letter-spacing: 1px;
  cursor: pointer;
  padding: 2px 6px;
  margin-left: 10px;
  opacity: 0.65;
}
.chat__btn:hover,
.chat__btn--on {
  border-color: var(--app-color, #39ff14);
  opacity: 1;
}
.chat__meta {
  margin-left: auto;
  margin-right: 12px;
  opacity: 0.8;
}
/* R5：离线时抽屉底部输入/NEW 视觉禁用（置灰 + 禁点）；
   房行与 ✕ 删除保持可点——removeRoom 是纯本地操作，join/create 在 useChat 内静默 no-op */
.chat__drawer--offline :deep(.drawer__foot) {
  opacity: 0.4;
  pointer-events: none;
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
.chat__err {
  margin: 0;
  padding: 6px 16px;
  font-size: 11px;
  color: #ff6b6b;
  opacity: 0.85;
}
</style>
