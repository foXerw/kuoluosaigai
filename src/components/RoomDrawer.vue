<template>
  <aside class="drawer">
    <div class="drawer__head">
      <span class="drawer__title">▚ ROOMS</span>
    </div>

    <div class="drawer__body">
      <section class="drawer__section">
        <h3 class="drawer__label">PUBLIC</h3>
        <div
          v-for="id in publicRooms"
          :key="id"
          class="drawer__row drawer__row--public"
          :class="{ 'is-current': id === current }"
          @click="join(id)"
        >
          <span class="drawer__dot" :style="{ color: dotColor(id) }">●</span>
          <span class="drawer__name">{{ displayName(id) }}</span>
          <span class="drawer__count">{{ countOf(id) }}</span>
        </div>
      </section>

      <section v-if="privateRooms.length" class="drawer__section">
        <h3 class="drawer__label">MY ROOMS</h3>
        <div
          v-for="id in privateRooms"
          :key="id"
          class="drawer__row drawer__row--private"
          :class="{ 'is-current': id === current }"
          @click="join(id)"
        >
          <span class="drawer__dot">●</span>
          <span class="drawer__name">{{ id }}</span>
          <span class="drawer__count">{{ countOf(id) }}</span>
          <button class="drawer__copy" :title="id" @click.stop="copyId(id)">
            {{ copiedId === id ? 'COPIED' : '⧉' }}
          </button>
          <button class="drawer__remove" @click.stop="remove(id)">✕</button>
        </div>
      </section>

      <p v-if="notice" class="drawer__notice">! {{ notice }}</p>
    </div>

    <form class="drawer__foot" @submit.prevent="onSubmit">
      <span class="drawer__prompt">&gt;</span>
      <input v-model="idDraft" class="drawer__field" placeholder="id" spellcheck="false" />
      <button type="submit" class="drawer__go">⏎</button>
      <button type="button" class="drawer__new" @click="$emit('create')">[+ NEW]</button>
    </form>
  </aside>
</template>

<script>
import { ref, computed, onBeforeUnmount } from 'vue'
import { PUBLIC_ROOM_IDS, channelByRoomId } from '../theme/channels'

const COPIED_MS = 1000 // ⧉ → COPIED 的回显窗口，兼作防重复点击护栏

export default {
  name: 'RoomDrawer',
  props: {
    rooms: { type: Array, default: () => [] }, // string[]：全部房间 id（含公共房）
    current: { type: String, default: '' },
    counts: { type: Object, default: () => ({}) }, // roomId → 在线数（缺 key 显示 --）
    notice: { type: String, default: '' }, // '' | 'NO SUCH ROOM' | ...
  },
  emits: ['join', 'create', 'remove'],
  setup(props, { emit }) {
    const idDraft = ref('')
    const copiedId = ref('')
    let copyTimer = null

    // 公共区按 PUBLIC_ROOM_IDS 固定顺序；MY ROOMS 收纳其余 id（保持存储序）
    const publicRooms = computed(() => PUBLIC_ROOM_IDS.filter((id) => props.rooms.includes(id)))
    const privateRooms = computed(() => props.rooms.filter((id) => !PUBLIC_ROOM_IDS.includes(id)))

    function displayName(id) {
      return channelByRoomId(id)?.prefix || id
    }

    function dotColor(id) {
      return channelByRoomId(id)?.color || 'var(--app-color, #39ff14)'
    }

    function countOf(id) {
      const c = props.counts[id]
      return c == null ? '--' : String(c)
    }

    function join(roomId) {
      emit('join', roomId)
    }

    function remove(roomId) {
      emit('remove', roomId)
    }

    function onSubmit() {
      const id = idDraft.value.trim()
      if (!id) return
      emit('join', id)
      idDraft.value = ''
    }

    // execCommand 兜底：老浏览器/非安全上下文无 navigator.clipboard 时经由隐藏 textarea 复制
    function legacyCopy(text) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.readOnly = true
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        try {
          ta.select()
          return document.execCommand('copy') === true
        } finally {
          document.body.removeChild(ta) // execCommand 抛错也要回收节点
        }
      } catch {
        return false
      }
    }

    function markCopied(roomId) {
      copiedId.value = roomId
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copiedId.value = ''
        copyTimer = null
      }, COPIED_MS)
    }

    function copyId(roomId) {
      if (copiedId.value === roomId) return // COPIED 窗口内重复点击：直接吞掉
      let ok = false
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          const r = navigator.clipboard.writeText(roomId)
          if (r && typeof r.catch === 'function') r.catch(() => {})
          ok = true
        } catch {
          ok = false
        }
      }
      if (!ok) ok = legacyCopy(roomId)
      if (ok) markCopied(roomId)
    }

    onBeforeUnmount(() => {
      if (copyTimer) {
        clearTimeout(copyTimer)
        copyTimer = null
      }
    })

    return {
      idDraft,
      copiedId,
      publicRooms,
      privateRooms,
      displayName,
      dotColor,
      countOf,
      join,
      remove,
      onSubmit,
      copyId,
    }
  },
}
</script>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 90;
  width: 280px;
  background: #061006;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  border-left: 1px solid #1f2a1f;
  display: flex;
  flex-direction: column;
}
.drawer__head {
  padding: 10px 16px;
  border-bottom: 1px solid #1f2a1f;
  font-size: 12px;
  letter-spacing: 1px;
}
.drawer__title {
  opacity: 0.9;
}
.drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 13px;
}
.drawer__section {
  margin-bottom: 14px;
}
.drawer__label {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: normal;
  letter-spacing: 2px;
  opacity: 0.45;
}
.drawer__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  cursor: pointer;
  border: 1px solid transparent;
}
.drawer__row:hover {
  background: #0a0e0a;
  border-color: #1f2a1f;
}
.drawer__row.is-current {
  background: #0a0e0a;
  border-color: #1f2a1f;
}
.drawer__row.is-current .drawer__name::before {
  content: '▸ ';
}
.drawer__dot {
  font-size: 10px;
}
.drawer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawer__count {
  opacity: 0.6;
  font-size: 11px;
}
.drawer__copy {
  background: none;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 10px;
  cursor: pointer;
  padding: 1px 6px;
  min-width: 58px;
}
.drawer__copy:hover {
  border-color: var(--app-color, #39ff14);
}
.drawer__remove {
  background: none;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
}
.drawer__remove:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
}
.drawer__notice {
  margin: 0;
  padding: 6px 8px;
  font-size: 11px;
  color: #ff6b6b;
  opacity: 0.85;
  letter-spacing: 1px;
}
.drawer__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-top: 1px solid #1f2a1f;
}
.drawer__prompt {
  opacity: 0.6;
}
.drawer__field {
  flex: 1;
  min-width: 0;
  background: #0a0e0a;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
}
.drawer__go {
  background: none;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  cursor: pointer;
  padding: 4px 8px;
}
.drawer__new {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  font-size: 11px;
  cursor: pointer;
  padding: 4px 6px;
  letter-spacing: 1px;
}
.drawer__new:hover {
  background: #0a0e0a;
}
</style>
