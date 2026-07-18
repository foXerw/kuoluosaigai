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
      />
      <ScanlineWipe v-if="phase === 'wiping'" @done="onWipeDone" />
      <ChatRoom v-if="chatOpen" :url="wsUrl" :channel="channel" @close="closeChat" />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatRoom from './components/ChatRoom.vue'
import ScanlineWipe from './components/ScanlineWipe.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'

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
    ScanlineWipe,
  },
  data() {
    return {
      phase: 'boot',
      channel: null,
      chatOpen: false,
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
  },
  beforeUnmount() {
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
    closeChat() {
      this.chatOpen = false
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
