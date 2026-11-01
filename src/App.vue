<template>
  <a-config-provider :theme="themeConfig">
    <div class="app" :class="phaseClass">
      <BootSequence
        v-if="phase === 'boot' || phase === 'wiping'"
        class="app__boot"
        :reduced-motion="reducedMotion"
        @ready="onReady"
      />
      <ChannelShell
        v-if="phase === 'wiping' || phase === 'shell'"
        class="app__shell"
        :channel="channel"
        @enter="openChat"
        @reshuffle="reshuffle"
        @botdeck="openBotDeck"
      />
      <ScanlineWipe v-if="phase === 'wiping'" @done="onWipeDone" />
      <ChatRoom v-if="chatOpen" :url="wsUrl" :channel="channel" @close="closeChat" />
      <!-- 与 ChatRoom 并列不嵌套：关聊天室不影响 botStore（放飞模式根基） -->
      <BotDeck
        v-if="botDeckOpen"
        :store="botStore"
        :initial-room-id="channel.roomId"
        @close="botDeckOpen = false"
      />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatRoom from './components/ChatRoom.vue'
import BotDeck from './components/BotDeck.vue'
import ScanlineWipe from './components/ScanlineWipe.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'
import { createBotStore } from './bots/store'

// Safety fallback for the wipe phase. --wipe-ms is 600ms in src/styles/terminal.css;
// this is 600ms wipe + 200ms slack in case the ScanlineWipe animationend never fires
// (e.g. tab backgrounded, animation cancelled), which would otherwise leave the app
// stuck in `wiping` and the fading boot layer swallowing pointer events.
const WIPE_FALLBACK_MS = 800

// WS 端点：优先用构建期注入的 VUE_APP_WS_URL；未配置则按页面同源推导
// （统一生产服务把 ws 挂在与页面相同的 host:port，无需额外配置）
function resolveWsUrl() {
  const env = process.env.VUE_APP_WS_URL
  if (env) return env
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}

export default {
  name: 'App',
  components: {
    'a-config-provider': ConfigProvider,
    BootSequence,
    ChannelShell,
    ChatRoom,
    BotDeck,
    ScanlineWipe,
  },
  data() {
    return {
      phase: 'boot',
      channel: null,
      chatOpen: false,
      botDeckOpen: false,
      wsUrl: resolveWsUrl(),
      reducedMotion: false,
      wipeTimer: null,
    }
  },
  computed: {
    phaseClass() {
      return 'app--' + this.phase
    },
    currentColor() {
      return this.channel?.color || '#39ff14'
    },
    currentGlow() {
      return this.channel?.glow || '#39ff14'
    },
    themeConfig() {
      return { token: { colorPrimary: this.currentColor } }
    },
  },
  watch: {
    currentColor: {
      immediate: true,
      handler(value) {
        if (typeof document !== 'undefined') {
          document.documentElement.style.setProperty('--app-color', value)
        }
      },
    },
    currentGlow: {
      immediate: true,
      handler(value) {
        if (typeof document !== 'undefined') {
          document.documentElement.style.setProperty('--app-glow', value)
        }
      },
    },
  },
  created() {
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.channel = pickChannel()
    // botStore：App 层单例（实例字段，不进 data——store 本体已是 reactive，
    // 再包一层无益且防 Vue 深侦 runner 句柄）。构造不建连，只有 startBot 才连 WS。
    // 持久配置加载在 createBotStore 构造尾 loadInto() 完成——此处不再重复 store.load()
    //（终审 M3：删冗余读盘；load() 仍为公开 API 供他处需要重载时用）
    this.botStore = createBotStore({ wsUrl: this.wsUrl })
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.onUnload)
    }
  },
  beforeUnmount() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.onUnload)
    }
    this.botStore.dispose()
    if (this.wipeTimer) {
      clearTimeout(this.wipeTimer)
      this.wipeTimer = null
    }
  },
  methods: {
    onReady() {
      this.phase = this.reducedMotion ? 'shell' : 'wiping'
      if (this.phase === 'wiping') {
        this.wipeTimer = setTimeout(() => {
          if (this.phase === 'wiping') this.phase = 'shell'
        }, WIPE_FALLBACK_MS)
      }
    },
    onWipeDone() {
      if (this.wipeTimer) {
        clearTimeout(this.wipeTimer)
        this.wipeTimer = null
      }
      this.phase = 'shell'
    },
    openChat() {
      this.chatOpen = true
    },
    openBotDeck() {
      this.botDeckOpen = true
    },
    // B12：关页面/刷新前停全部 runner、释放租约、冲刷用量——
    // 否则其他标签页被死租约挡 45s，且本会话 token 用量丢失
    onUnload() {
      this.botStore.dispose()
    },
    closeChat() {
      this.chatOpen = false
      // 色随房收尾：ChatRoom 期间可能把 --app-color/--app-glow 切去了别的房；
      // channel watcher 值未变不会重放，这里显式恢复落地频道色
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--app-color', this.currentColor)
        document.documentElement.style.setProperty('--app-glow', this.currentGlow)
      }
    },
    reshuffle() {
      this.channel = reshuffleChannel()
    },
  },
}
</script>

<style scoped>
.app {
  position: relative;
  min-height: 100vh;
}
.app__boot { opacity: 1; }
.app__shell { opacity: 1; }
.app--wiping .app__boot {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: bootOut var(--wipe-ms) ease-in forwards;
}
.app--wiping .app__shell {
  animation: shellIn var(--wipe-ms) ease-in;
}
@keyframes bootOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes shellIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
