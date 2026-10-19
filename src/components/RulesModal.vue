<template>
  <div class="rules" role="dialog" aria-modal="true" aria-label="站内规则">
    <header class="rules__top">
      <span class="rules__title">? RULES // 站内规则</span>
      <button class="rules__close" aria-label="关闭" @click="$emit('close')">✕</button>
    </header>

    <div class="rules__body">
      <div class="rules__inner">
        <p class="rules__lede">&gt; cat RULES.md —— 一条街一条规矩，读完只需一分钟。</p>

        <section v-for="sec in sections" :key="sec.title" class="rules__section">
          <h3 class="rules__sec-title">{{ sec.title }}</h3>
          <p v-for="(line, i) in sec.lines" :key="i" class="rules__line">&gt; {{ line }}</p>
        </section>

        <p class="rules__foot">EOF · [✕] 关掉本页，街还在。</p>
      </div>
    </div>
  </div>
</template>

<script>
import { RULES_SECTIONS } from '../chat/rulesContent'

export default {
  name: 'RulesModal',
  emits: ['close'],
  setup() {
    return { sections: RULES_SECTIONS }
  },
}
</script>

<style scoped>
.rules {
  position: fixed;
  inset: 0;
  z-index: 110; /* 盖住 ChatRoom(100) 与抽屉(90) */
  background: rgba(6, 16, 6, 0.97);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  display: flex;
  flex-direction: column;
}
.rules__top {
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
.rules__title {
  opacity: 0.9;
}
.rules__close {
  background: none;
  border: 1px solid var(--app-color, #39ff14);
  color: var(--app-color, #39ff14);
  font-family: var(--app-mono);
  cursor: pointer;
  padding: 2px 8px;
}
.rules__close:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
}
.rules__body {
  flex: 1;
  overflow-y: auto; /* 小屏内滚，头部固定 */
  padding: 20px 16px 32px;
}
.rules__inner {
  max-width: 640px;
  margin: 0 auto;
}
.rules__lede,
.rules__foot {
  margin: 0 0 20px;
  font-size: 11px;
  letter-spacing: 1px;
  opacity: 0.5;
}
.rules__foot {
  margin: 24px 0 0;
}
.rules__section {
  margin-bottom: 22px;
}
.rules__sec-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: normal;
  letter-spacing: 1px;
  opacity: 0.9;
  border-bottom: 1px dashed #1f2a1f;
  padding-bottom: 4px;
}
.rules__line {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.7;
  opacity: 0.85;
  word-break: break-word;
}
</style>
