<template>
  <div class="deck" role="dialog" aria-modal="true" aria-label="BOT DECK">
    <header class="deck__top">
      <span class="deck__title">&gt; BOT DECK // 个人 AI Bot 控制台</span>
      <button class="deck__close" aria-label="关闭" @click="$emit('close')">✕</button>
    </header>

    <div class="deck__body">
      <p v-if="store.storageDegraded" class="deck__warn deck__warn--yellow">
        &gt; ⚠ localStorage 写入失败——本次配置仅存内存，刷新即丢（B17）。
      </p>
      <p v-if="store.leaseDegraded" class="deck__warn deck__warn--yellow">
        &gt; ⚠ 存储异常，跨标签互斥降级——多标签同开一个 bot 会双份烧 token。
      </p>

      <section class="deck__sec">
        <h3 class="deck__sec-title">&gt; PROVIDERS</h3>
        <div class="deck__presets">
          <button v-for="p in presets" :key="p.name" class="deck__preset" @click="usePreset(p)">
            {{ p.name }}
          </button>
        </div>
        <form class="deck__pform" @submit.prevent="submitProvider">
          <input v-model="prov.name" class="deck__name-input" placeholder="名称" />
          <input v-model="prov.baseUrl" class="deck__baseurl-input" placeholder="https://api.example.com/v1" spellcheck="false" />
          <input v-model="prov.apiKey" class="deck__key-input" type="password" placeholder="API key" autocomplete="off" spellcheck="false" />
          <button class="deck__prov-add" type="button" @click="submitProvider">+ ADD</button>
        </form>
        <p class="deck__note">&gt; token 只存本机浏览器，页面代码直连 AI 服务商（model 在各 bot 上选）。</p>
        <ul class="deck__plist">
          <li v-for="p in store.providers" :key="p.id" class="deck__prov">
            ▸ {{ p.name }} · {{ p.baseUrl }} · key {{ p.apiKey ? '●●● 已设' : '未设' }}
          </li>
          <li v-if="!store.providers.length" class="deck__empty">&gt; 还没有 provider——上面选个预设加一个。</li>
        </ul>
      </section>

      <section class="deck__sec">
        <h3 class="deck__sec-title">
          &gt; BOTS <span class="deck__count">[{{ store.bots.length }}/{{ maxBots }}]</span>
        </h3>
        <p v-if="atMax" class="deck__warn">&gt; MAX · {{ store.bots.length }}/{{ maxBots }} 已满，删一个才能再建。</p>
        <BotCard
          v-for="bot in store.bots"
          :key="bot.id"
          :bot="bot"
          :providers="store.providers"
          @start="store.startBot(bot.id)"
          @stop="store.stopBot(bot.id)"
          @switch-room="(rid) => store.switchBotRoom(bot.id, rid)"
          @clear-buffer="store.clearBotBuffer(bot.id)"
          @update="(patch) => store.updateBot(bot.id, patch)"
          @remove="store.removeBot(bot.id)"
        />
        <p v-if="!store.bots.length" class="deck__empty">&gt; 空船坞——下面 NEW BOT 造一个。</p>
      </section>

      <section class="deck__sec">
        <h3 class="deck__sec-title">&gt; NEW BOT</h3>
        <form class="deck__bform" @submit.prevent="submitBot">
          <label>
            人格名 {{ form.name.length }}/12
            <input v-model="form.name" class="deck__bot-name-input" maxlength="12" placeholder="≤12 字" />
          </label>
          <label>
            性格描述
            <textarea v-model="form.persona" class="deck__persona-input" rows="2" placeholder="它是什么路数的嘴替"></textarea>
          </label>
          <label>
            话痨度 {{ form.chattiness }}
            <input v-model.number="form.chattiness" class="deck__chattiness-input" type="range" min="0" max="100" />
          </label>
          <label>
            Provider
            <select v-model="form.providerId" class="deck__provider-select">
              <option :value="null">（未选——可先建后编辑）</option>
              <option v-for="p in store.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label>
            Model
            <input v-model="form.model" class="deck__model-input" placeholder="deepseek-chat 等" spellcheck="false" />
          </label>
          <label>
            Temperature {{ form.temperature }}
            <input v-model.number="form.temperature" class="deck__temp-input" type="range" min="0" max="2" step="0.1" />
          </label>
          <label>
            初始房间
            <input v-model="form.roomId" class="deck__room-input" placeholder="房间 ID" spellcheck="false" />
          </label>
          <button class="deck__create" type="button" :disabled="atMax" @click="submitBot">+ 新建 BOT</button>
          <p v-if="createError" class="deck__errline">&gt; {{ createError }}</p>
        </form>
      </section>

      <p class="deck__foot">&gt; badge（BOT·人格名）公开可被仿造 · 标签页后台时定时器节流，回复迟到属预期（B14）。[ESC] 关面板，bot 照跑。</p>
    </div>
  </div>
</template>

<script>
// BotDeck（Task 9 / spec §8.4）：BOT 控制台覆盖层——providers 配置 + 卡片列表 + 新建表单。
// 唯一数据入口是 props.store（Task 8 createBotStore 单例）：卡片只 emit，本组件负责接线
// startBot/stopBot/switchBotRoom/clearBotBuffer/updateBot/removeBot。
// otherTab 刷新路径（审查轮 1 Finding #1 收口）：本组件监听 window 'storage'(LEASE_KEY)
// 只作触发信号，判定全部交给 store.refreshLeases()——组件不复刻租约解析器/tabId 排除/
// 新鲜度计算，storage 注入差异（T10 传非默认 storage）也不影响刷新。
import BotCard from './BotCard.vue'
import { MAX_BOTS, PROVIDER_PRESETS } from '../bots/store'
import { LEASE_KEY } from '../bots/lease'
import { PUBLIC_ROOM_IDS } from '../theme/channels'

export default {
  name: 'BotDeck',
  components: { BotCard },
  props: {
    store: { type: Object, required: true },
  },
  emits: ['close'],
  data() {
    return {
      presets: PROVIDER_PRESETS,
      maxBots: MAX_BOTS,
      prov: { name: '', baseUrl: '', apiKey: '' },
      form: {
        name: '',
        persona: '',
        chattiness: 50,
        providerId: null,
        model: '',
        temperature: 0.7,
        roomId: PUBLIC_ROOM_IDS[0] || '',
      },
      createError: '',
    }
  },
  computed: {
    atMax() {
      return this.store.bots.length >= MAX_BOTS
    },
  },
  mounted() {
    this._onKey = (e) => {
      if (e.key === 'Escape') this.$emit('close')
    }
    this._onStorage = (e) => {
      if (e.key !== LEASE_KEY) return
      this.store.refreshLeases()
    }
    window.addEventListener('keydown', this._onKey)
    window.addEventListener('storage', this._onStorage)
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this._onKey)
    window.removeEventListener('storage', this._onStorage)
  },
  methods: {
    usePreset(p) {
      this.prov.name = p.name
      this.prov.baseUrl = p.baseUrl
    },
    submitProvider() {
      const name = this.prov.name.trim()
      const baseUrl = this.prov.baseUrl.trim()
      if (!name || !baseUrl) return // 名称/baseUrl 缺一不提交
      this.store.addProvider({ name, baseUrl, apiKey: this.prov.apiKey })
      this.prov = { name: '', baseUrl: '', apiKey: '' } // key 输入即清（不回显残留）
    },
    submitBot() {
      if (this.atMax) return
      const name = this.form.name.trim()
      const roomId = this.form.roomId.trim()
      if (!name) {
        this.createError = '人格名必填（≤12 字）'
        return
      }
      if (!roomId) {
        this.createError = '初始房间 ID 必填'
        return
      }
      const res = this.store.addBot({
        name,
        persona: this.form.persona,
        chattiness: Number(this.form.chattiness),
        providerId: this.form.providerId,
        model: this.form.model.trim(),
        temperature: Number(this.form.temperature),
        roomId,
      })
      if (res && res.error === 'MAX_BOTS') {
        this.createError = `MAX · 上限 ${MAX_BOTS} 个 bot`
        return
      }
      this.createError = ''
      this.form.name = ''
      this.form.persona = ''
    },
  },
}
</script>

<style scoped>
.deck {
  position: fixed;
  inset: 0;
  z-index: 120; /* 盖过 RulesModal(110)；与聊天室弹窗互不嵌套可同时开 */
  background: rgba(6, 16, 6, 0.97);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  display: flex;
  flex-direction: column;
}
.deck__top {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid #1f2a1f;
  font-size: 12px;
  letter-spacing: 1px;
}
.deck__close {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  cursor: pointer;
  padding: 2px 8px;
}
.deck__close:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
}
.deck__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 32px;
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
}
.deck__sec {
  margin-bottom: 24px;
}
.deck__sec-title {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: normal;
  letter-spacing: 1px;
  border-bottom: 1px dashed #1f2a1f;
  padding-bottom: 4px;
}
.deck__count {
  opacity: 0.6;
}
.deck__warn {
  margin: 0 0 12px;
  color: #ffb000;
  border: 1px solid #3a2f10;
  padding: 4px 8px;
}
.deck__presets {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.deck__preset {
  background: none;
  border: 1px solid #1f2a1f;
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  cursor: pointer;
  padding: 2px 10px;
}
.deck__preset:hover {
  border-color: var(--app-color, #39ff14);
}
.deck__pform,
.deck__bform {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.deck__pform {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}
.deck__pform input {
  flex: 1;
  min-width: 140px;
}
.deck__bform label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.deck input,
.deck textarea,
.deck select {
  background: none;
  border: 1px solid #1f2a1f;
  color: inherit;
  font-family: var(--app-mono);
  padding: 3px 8px;
  flex: 1;
  min-width: 120px;
}
.deck input[type="range"] {
  padding: 0;
  border: none;
  accent-color: var(--app-color, #39ff14);
}
.deck__create,
.deck__prov-add {
  align-self: flex-start;
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  cursor: pointer;
  padding: 3px 14px;
}
.deck__create:disabled,
.deck__prov-add:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.deck__note {
  margin: 8px 0;
  opacity: 0.75;
  font-size: 11px;
}
.deck__plist {
  list-style: none;
  margin: 0;
  padding: 0;
}
.deck__prov {
  padding: 2px 0;
  word-break: break-word;
}
.deck__empty {
  margin: 4px 0;
  opacity: 0.5;
}
.deck__errline {
  margin: 0;
  color: #ff6b6b;
}
.deck__foot {
  margin: 0;
  font-size: 11px;
  letter-spacing: 1px;
  opacity: 0.5;
}
</style>
