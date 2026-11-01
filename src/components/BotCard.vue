<template>
  <article class="bot-card" :class="{ 'bot-card--other': bot.rt.otherTab }">
    <header class="bot-card__head">
      <span class="bot-card__lamp" :class="`bot-card__lamp--${bot.rt.status}`" :title="statusLabel"></span>
      <span class="bot-card__name">{{ bot.name }}</span>
      <span class="bot-card__badge">BOT·{{ bot.name }}</span>
      <span class="bot-card__state">{{ statusLabel }}</span>
      <span v-if="bot.rt.otherTab" class="bot-card__tabhint">在另一标签运行中</span>
    </header>

    <p v-if="bot.rt.error" class="bot-card__error">&gt; {{ bot.rt.error }}</p>

    <div class="bot-card__meta">
      <label class="bot-card__room">
        &gt; 当前房 {{ currentRoom || '—' }}
        <input
          v-model="roomDraft"
          class="bot-card__room-input"
          :placeholder="currentRoom || '房间 ID'"
          spellcheck="false"
          @keyup.enter="confirmRoom"
        />
        <button class="bot-card__room-go" :disabled="!canSwitch || bot.rt.otherTab" @click="confirmRoom">切房</button>
      </label>
      <span class="bot-card__stat">
        会话 tokens {{ bot.rt.session.promptTokens }}p / {{ bot.rt.session.completionTokens }}c ·
        发言 {{ bot.rt.session.messages }}
      </span>
      <span class="bot-card__stat">小时余量 {{ hourLeft }}/{{ hourlyCap }}</span>
    </div>

    <footer class="bot-card__ops">
      <button class="bot-card__start" :disabled="startDisabled" @click="$emit('start')">▶ 启动</button>
      <button class="bot-card__stop" :disabled="stopDisabled" @click="$emit('stop')">■ 停止</button>
      <button class="bot-card__expand" @click="expanded = !expanded">
        {{ expanded ? '收起观战' : '展开观战' }}
      </button>
      <button class="bot-card__edit-toggle" @click="toggleEdit">{{ editing ? '取消编辑' : '编辑' }}</button>
      <button class="bot-card__remove" @click="$emit('remove')">✕ 删除</button>
    </footer>

    <div v-if="expanded" class="bot-card__watch">
      <div class="bot-card__frames">
        <p v-for="(f, i) in frames" :key="i" class="bot-card__frame">
          <span v-if="f.badge" class="bot-card__frame-badge">[{{ f.badge }}]</span>
          <span class="bot-card__frame-nick">{{ f.nick }}</span>
          <span class="bot-card__frame-text">{{ f.text }}</span>
        </p>
        <p v-if="!frames.length" class="bot-card__empty">&gt; 缓冲为空——进房开聊或等 bot 自己开口。</p>
      </div>
      <button class="bot-card__clear" @click="$emit('clear-buffer')">清空缓冲</button>
    </div>

    <form v-if="editing" class="bot-card__edit" @submit.prevent="saveEdit">
      <p v-if="running" class="bot-card__hint">&gt; 运行中：实例持创建时快照，保存后需重启才生效。</p>
      <label>人格名 <input v-model="draft.name" class="bot-card__name-input" maxlength="12" /></label>
      <label>性格 <textarea v-model="draft.persona" class="bot-card__persona-input" rows="2"></textarea></label>
      <label>
        话痨度 {{ draft.chattiness }}
        <input v-model.number="draft.chattiness" class="bot-card__chattiness-input" type="range" min="0" max="100" />
      </label>
      <label>
        Provider
        <select v-model="draft.providerId" class="bot-card__provider-select">
          <option :value="null">（未选）</option>
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label>Model <input v-model="draft.model" class="bot-card__model-input" spellcheck="false" /></label>
      <label>
        Temperature {{ draft.temperature }}
        <input v-model.number="draft.temperature" class="bot-card__temp-input" type="range" min="0" max="2" step="0.1" />
      </label>
      <button class="bot-card__save" type="button" @click="saveEdit">保存</button>
    </form>
  </article>
</template>

<script>
// BotCard（Task 9 / spec §8.4）：单 bot 卡片——纯展示 + 操作 emit，
// store 调用归 BotDeck（props 只有 {bot, providers}，不摸 store）。
// 观战窗数据 = bot.bufferFrames()（store.getBuffer 的委托糖），rt.rev 是刷新信号；
// B9：error 文案按 runner 契约永不含 key，卡片也只渲染 provider 的 name，不碰 apiKey。
import { RHYTHM_DEFAULTS } from '../bots/rhythm'

const RUNNING_STATUSES = ['connecting', 'open', 'cooling'] // 本 tab 在跑（error 不算）
const STATUS_LABELS = {
  stopped: 'STOPPED',
  connecting: 'CONNECTING…',
  open: 'RUNNING',
  cooling: 'COOLING（rate 冷却）',
  error: 'ERROR',
}

export default {
  name: 'BotCard',
  props: {
    bot: { type: Object, required: true },
    providers: { type: Array, default: () => [] },
  },
  emits: ['start', 'stop', 'switch-room', 'clear-buffer', 'update', 'remove'],
  data() {
    return {
      expanded: false,
      editing: false,
      roomDraft: '',
      draft: { name: '', persona: '', chattiness: 50, providerId: null, model: '', temperature: 0.7 },
    }
  },
  computed: {
    running() {
      return RUNNING_STATUSES.includes(this.bot.rt.status)
    },
    statusLabel() {
      return STATUS_LABELS[this.bot.rt.status] || this.bot.rt.status
    },
    currentRoom() {
      return this.bot.rt.roomId || this.bot.roomId || ''
    },
    canSwitch() {
      return !!this.roomDraft.trim() && this.roomDraft.trim() !== this.currentRoom
    },
    startDisabled() {
      return this.bot.rt.otherTab || this.running
    },
    stopDisabled() {
      return this.bot.rt.otherTab || !this.running
    },
    hourlyCap() {
      return RHYTHM_DEFAULTS.hourlyCap
    },
    hourLeft() {
      return Math.max(0, RHYTHM_DEFAULTS.hourlyCap - (this.bot.rt.hourCount || 0))
    },
    frames() {
      this.bot.rt.rev // rev 变化即重读缓冲（裁定 F3：getBuffer 权威）
      return typeof this.bot.bufferFrames === 'function' ? this.bot.bufferFrames() : []
    },
  },
  methods: {
    confirmRoom() {
      const roomId = this.roomDraft.trim()
      if (!roomId) return
      this.$emit('switch-room', roomId)
    },
    toggleEdit() {
      this.editing = !this.editing
      if (this.editing) {
        const b = this.bot
        this.draft = {
          name: b.name,
          persona: b.persona,
          chattiness: b.chattiness,
          providerId: b.providerId,
          model: b.model,
          temperature: b.temperature,
        }
      }
    },
    saveEdit() {
      this.$emit('update', {
        name: this.draft.name,
        persona: this.draft.persona,
        chattiness: Number(this.draft.chattiness),
        providerId: this.draft.providerId,
        model: this.draft.model,
        temperature: Number(this.draft.temperature),
      })
      this.editing = false
    },
  },
}
</script>

<style scoped>
.bot-card {
  border: 1px solid #1f2a1f;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-family: var(--app-mono);
  font-size: 12px;
  color: var(--app-color, #39ff14);
  background: rgba(10, 18, 10, 0.6);
}
.bot-card--other {
  border-color: #3a2f10;
}
.bot-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bot-card__lamp {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid #1f2a1f;
  flex: none;
}
.bot-card__lamp--stopped {
  background: #333;
}
.bot-card__lamp--connecting {
  background: #ffb000;
}
.bot-card__lamp--open {
  background: #39ff14;
}
.bot-card__lamp--cooling {
  background: #22d3ee;
}
.bot-card__lamp--error {
  background: #ff6b6b;
}
.bot-card__name {
  font-size: 14px;
}
.bot-card__badge {
  opacity: 0.6;
  border: 1px dashed #1f2a1f;
  padding: 0 6px;
}
.bot-card__state {
  opacity: 0.8;
  letter-spacing: 1px;
}
.bot-card__tabhint {
  color: #ffb000;
}
.bot-card__error {
  margin: 6px 0 0;
  color: #ff6b6b;
  word-break: break-word;
}
.bot-card__meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: 8px 0;
  opacity: 0.9;
}
.bot-card__room {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bot-card__room-input {
  background: none;
  border: 1px solid #1f2a1f;
  color: inherit;
  font-family: var(--app-mono);
  padding: 1px 6px;
  width: 120px;
}
.bot-card__room-go,
.bot-card__ops button,
.bot-card__clear,
.bot-card__save {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  cursor: pointer;
  padding: 1px 8px;
  font-size: 11px;
}
.bot-card__room-go:disabled,
.bot-card__ops button:disabled,
.bot-card__clear:disabled,
.bot-card__save:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.bot-card__ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.bot-card__remove {
  border-color: #ff6b6b !important;
  color: #ff6b6b !important;
}
.bot-card__watch {
  margin-top: 10px;
  border-top: 1px dashed #1f2a1f;
  padding-top: 8px;
}
.bot-card__frames {
  max-height: 180px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.45);
  padding: 6px 8px;
}
.bot-card__frame {
  margin: 0 0 4px;
  line-height: 1.5;
  word-break: break-word;
}
.bot-card__frame-badge {
  opacity: 0.7;
}
.bot-card__frame-nick {
  opacity: 0.85;
}
.bot-card__frame-nick::after {
  content: ':';
  margin: 0 4px;
}
.bot-card__empty {
  margin: 0;
  opacity: 0.5;
}
.bot-card__edit {
  margin-top: 10px;
  border-top: 1px dashed #1f2a1f;
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bot-card__edit label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bot-card__edit input,
.bot-card__edit textarea,
.bot-card__edit select {
  background: none;
  border: 1px solid #1f2a1f;
  color: inherit;
  font-family: var(--app-mono);
  padding: 2px 6px;
  flex: 1;
  min-width: 120px;
}
.bot-card__hint {
  margin: 0;
  color: #ffb000;
}
</style>
