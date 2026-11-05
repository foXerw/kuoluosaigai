<template>
  <div class="remote">
    <section class="remote__pair">
      <h3 class="remote__title">&gt; PAIR DEVICE</h3>
      <p class="remote__note">
        &gt; 在 daemon 本机运行 <code>saigai-bot pair</code>，把 6 位配对码输在这里。
        session 凭证只存本浏览器。
      </p>
      <form class="remote__pform" @submit.prevent="doPair">
        <input
          v-model="code"
          class="remote__code"
          maxlength="6"
          placeholder="6 位配对码"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="remote__pair-go" type="submit" :disabled="pairing || !code">
          {{ pairing ? '配对中…' : '配对' }}
        </button>
      </form>
      <p v-if="pairError" class="remote__err">&gt; {{ pairError }}</p>
    </section>

    <section v-if="store.devices.length" class="remote__sec">
      <h3 class="remote__title">&gt; DEVICES</h3>
      <div class="remote__devices">
        <button
          v-for="d in store.devices"
          :key="d.deviceId"
          class="remote__device"
          :class="{ 'remote__device--on': d.deviceId === store.selectedId }"
          @click="selectDevice(d.deviceId)"
        >▸ {{ d.name }}</button>
      </div>
      <button class="remote__forget" type="button" @click="forgetSelected">
        仅从本机移除（不撤销服务器会话）
      </button>
    </section>

    <section v-if="store.selectedDevice" class="remote__sec">
      <div class="remote__status">
        <span class="remote__lamp" :class="lampClass"></span>
        <span>{{ store.selectedDevice.name }}</span>
        <span class="remote__state">{{ statusText }}</span>
        <button class="remote__refresh" type="button" @click="refreshSessions">刷新会话</button>
      </div>
      <p v-if="store.notice" class="remote__err">&gt; {{ store.notice }}</p>

      <ul v-if="store.sessions.length" class="remote__sessions">
        <li v-for="s in store.sessions" :key="s.sessionId" class="remote__session">
          {{ s.label || 'device' }} · {{ s.online ? '在线' : '离线' }}
          <span v-if="s.sessionId === currentSessionId">（本机）</span>
          <button
            class="remote__revoke"
            type="button"
            :disabled="s.sessionId === currentSessionId"
            :title="s.sessionId === currentSessionId ? '不能撤销正在使用的这浏览器' : '撤销该浏览器'"
            @click="revoke(s.sessionId)"
          >撤销</button>
        </li>
      </ul>

      <p class="remote__note remote__note--warn">
        &gt; 远端改人格/增删 bot 是运行时修改，daemon 重启后以配置文件为准；切房会持久化。
        API key 永不进中继——这里只能看到 {{ keyHintLabel }}，换 key 需在 daemon 本机操作。
      </p>

      <div :class="{ 'remote__cards--off': !controlsEnabled }" :title="controlsEnabled ? '' : 'daemon 不在线，操作不可用'">
        <BotCard
          v-for="bot in mappedBots"
          :key="bot.id"
          :bot="bot"
          :providers="mappedProviders"
          :show-watch="false"
          @start="act(store.startBot(bot.id))"
          @stop="act(store.stopBot(bot.id))"
          @switch-room="(rid) => act(store.switchRoom(bot.id, rid))"
          @clear-buffer="act(store.clearBuffer(bot.id))"
          @update="(patch) => update(bot.id, patch)"
          @remove="act(store.removeBot(bot.id))"
        />
      </div>
      <p v-if="!mappedBots.length" class="remote__empty">&gt; 这台 daemon 上没有 bot。</p>

      <form class="remote__add" @submit.prevent="addBot">
        <h3 class="remote__title">&gt; NEW BOT（远端）</h3>
        <input v-model="form.id" class="remote__field" placeholder="id（a-z0-9-）" spellcheck="false" />
        <input v-model="form.name" class="remote__field" placeholder="名字 ≤12" />
        <input v-model="form.persona" class="remote__field" placeholder="人格" />
        <input v-model="form.room" class="remote__field" placeholder="房间 ID" spellcheck="false" />
        <button class="remote__add-go" type="submit" :disabled="!canAdd">+ 添加</button>
        <p class="remote__note">&gt; 新 bot 使用这台 daemon 的 provider/key 立即生效；它只是运行时条目，daemon 重启后以配置文件为准（可能消失）。</p>
      </form>
    </section>
  </div>
</template>

<script>
import BotCard from './BotCard.vue'

const UPDATE_KEYS = ['name', 'persona', 'chattiness', 'temperature', 'model']

export default {
  name: 'RemoteDeck',
  components: { BotCard },
  props: {
    store: { type: Object, required: true },
  },
  data() {
    return {
      code: '',
      pairing: false,
      pairError: '',
      form: { id: '', name: '', persona: '', room: '' },
    }
  },
  computed: {
    statusText() {
      if (this.store.status === 'open') return this.store.online ? 'daemon 在线' : 'daemon 离线'
      const map = {
        idle: '未连接',
        connecting: '连接中',
        closed: '已断开',
        error: '连接错误',
        offline: '未配置端点',
      }
      return map[this.store.status] || this.store.status
    },
    controlsEnabled() {
      return this.store.status === 'open' && this.store.online
    },
    currentSessionId() {
      return this.store.selectedDevice ? this.store.selectedDevice.sessionId : null
    },
    lampClass() {
      if (this.store.status === 'open' && this.store.online) return 'remote__lamp--on'
      if (this.store.status === 'connecting') return 'remote__lamp--wait'
      return 'remote__lamp--off'
    },
    mappedBots() {
      return (this.store.bots || []).map((b) => ({
        id: b.id,
        name: b.name,
        persona: b.persona || '',
        chattiness: b.chattiness,
        temperature: b.temperature,
        model: b.model,
        providerId: b.providerId,
        roomId: b.room,
        hourlyBudget: undefined,
        rt: {
          status: b.status || 'stopped',
          error: null,
          nick: b.nick || null,
          roomId: b.room,
          session: b.session || { promptTokens: 0, completionTokens: 0, messages: 0 },
          hourCount: b.hourCount || 0,
          otherTab: false,
          rev: 0,
        },
        bufferFrames: () => [],
      }))
    },
    mappedProviders() {
      return (this.store.providers || []).map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: '',
      }))
    },
    keyHintLabel() {
      const hint = this.store.providers && this.store.providers[0] && this.store.providers[0].keyHint
      return hint || 'key 未配置'
    },
    canAdd() {
      return this.store.status === 'open' && /^[a-z0-9-]{1,32}$/.test(this.form.id) &&
        this.form.name.trim() !== '' && /^[a-z0-9]{5,8}$/.test(this.form.room)
    },
  },
  methods: {
    async doPair() {
      this.pairing = true
      this.pairError = ''
      try {
        await this.store.pair(this.code, 'browser')
        this.code = ''
      } catch (e) {
        this.pairError = '配对失败：码错误/过期，或设备通道不可达'
      } finally {
        this.pairing = false
      }
    },
    selectDevice(id) {
      this.store.select(id)
    },
    forgetSelected() {
      if (this.store.selectedId) this.store.removeDevice(this.store.selectedId)
    },
    async act(promise) {
      try {
        const res = await promise
        if (res && res.ok === false) this.store.setNotice?.(res.err || '操作失败')
      } catch (e) {
        this.store.setNotice?.('命令失败或超时')
      }
    },
    update(id, patch) {
      const filtered = {}
      for (const k of UPDATE_KEYS) if (k in patch) filtered[k] = patch[k]
      // BotCard 总是提交 model；空串会被 daemon 拒绝并连累同一次 persona 保存。
      if (filtered.model === '') delete filtered.model
      if (Object.keys(filtered).length) this.act(this.store.updateBot(id, filtered))
    },
    async refreshSessions() {
      try {
        await this.store.refreshSessions()
      } catch (e) {
        this.store.setNotice?.('会话列表获取失败')
      }
    },
    async revoke(sessionId) {
      try {
        const res = await this.store.revokeSession(sessionId)
        if (res && res.ok === false) this.store.setNotice?.(res.err || '撤销失败')
      } catch (e) {
        this.store.setNotice?.('撤销失败或超时')
      }
    },
    async addBot() {
      if (!this.canAdd) return
      try {
        const res = await this.store.addBot({
          id: this.form.id,
          name: this.form.name,
          persona: this.form.persona,
          room: this.form.room,
        })
        if (res && res.ok) {
          this.form = { id: '', name: '', persona: '', room: '' }
        } else {
          this.store.setNotice?.((res && res.err) || '添加失败')
        }
      } catch (e) {
        this.store.setNotice?.('添加失败或超时')
      }
    },
  },
}
</script>

<style scoped>
.remote {
  padding: 12px 18px 24px;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono, monospace);
  /* 手机主场景：必须和本地 deck 一样成为可滚动主体，否则下半部分够不着 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  box-sizing: border-box;
}
.remote__title { font-size: 12px; letter-spacing: 1px; opacity: 0.8; margin: 14px 0 8px; }
.remote__note { font-size: 11px; line-height: 1.6; opacity: 0.7; margin: 6px 0; }
.remote__note--warn { color: #ffcc66; opacity: 0.9; }
.remote__pform, .remote__add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.remote__code, .remote__field {
  background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(57, 255, 20, 0.35);
  color: inherit; padding: 5px 8px; font: inherit; font-size: 12px;
}
.remote__code { width: 120px; text-transform: uppercase; letter-spacing: 2px; }
.remote__pair-go, .remote__add-go, .remote__refresh, .remote__revoke, .remote__forget {
  background: transparent; border: 1px solid rgba(57, 255, 20, 0.45); color: inherit;
  padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer;
}
.remote__pform button:disabled, .remote__add-go:disabled { opacity: 0.35; cursor: default; }
.remote__devices { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.remote__device--on { background: rgba(57, 255, 20, 0.18); }
.remote__status { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 10px 0; }
.remote__lamp { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.remote__lamp--on { background: #39ff14; box-shadow: 0 0 6px #39ff14; }
.remote__lamp--wait { background: #ffcc66; }
.remote__lamp--off { background: #ff4444; }
.remote__state { opacity: 0.7; }
.remote__err { color: #ff6666; font-size: 11px; }
.remote__sessions { list-style: none; padding: 0; margin: 6px 0 12px; }
.remote__session { font-size: 11px; opacity: 0.85; padding: 3px 0; }
.remote__empty { font-size: 11px; opacity: 0.6; }
.remote__forget { margin-top: 4px; }
.remote__cards--off { opacity: 0.45; pointer-events: none; }
.remote__revoke:disabled { opacity: 0.3; cursor: default; }
</style>
