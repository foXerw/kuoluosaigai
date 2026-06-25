<template>
  <a-config-provider :theme="themeConfig">
    <div class="app">
      <BootSequence v-if="phase === 'boot'" :reduced-motion="reducedMotion" @ready="enter" />
      <ChannelShell v-else :channel="channel" @enter="openPlaceholder" @reshuffle="reshuffle" />
      <ChatPlaceholder :open="placeholderOpen" @close="placeholderOpen = false" />
    </div>
  </a-config-provider>
</template>

<script>
import { ConfigProvider } from 'ant-design-vue'
import BootSequence from './components/BootSequence.vue'
import ChannelShell from './components/ChannelShell.vue'
import ChatPlaceholder from './components/ChatPlaceholder.vue'
import { pickChannel, reshuffleChannel } from './theme/channels'

export default {
  name: 'App',
  components: {
    'a-config-provider': ConfigProvider,
    BootSequence,
    ChannelShell,
    ChatPlaceholder,
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
    enter() {
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
.app { min-height: 100vh; }
</style>
