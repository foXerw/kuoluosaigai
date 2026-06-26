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
        @enter="openPlaceholder"
        @reshuffle="reshuffle"
      />
      <ScanlineWipe v-if="phase === 'wiping'" @done="onWipeDone" />
      <ChatPlaceholder :open="placeholderOpen" @close="placeholderOpen = false" />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatPlaceholder from './components/ChatPlaceholder.vue'
import ScanlineWipe from './components/ScanlineWipe.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'

export default {
  name: 'App',
  components: {
    'a-config-provider': ConfigProvider,
    BootSequence,
    ChannelShell,
    ChatPlaceholder,
    ScanlineWipe,
  },
  data() {
    return {
      phase: 'boot',
      channel: null,
      placeholderOpen: false,
      reducedMotion: false,
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
  methods: {
    onReady() {
      this.phase = this.reducedMotion ? 'shell' : 'wiping'
    },
    onWipeDone() {
      this.phase = 'shell'
    },
    openPlaceholder() {
      this.placeholderOpen = true
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
