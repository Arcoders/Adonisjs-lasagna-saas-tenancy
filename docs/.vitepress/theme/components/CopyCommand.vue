<script setup lang="ts">
import { ref } from 'vue'

/**
 * Minimal copy-to-clipboard install line for the landing page. Styled with
 * VitePress's own `--vp-c-*` tokens so it follows the active theme (and the
 * minimalist restyle) without carrying any bespoke design tokens.
 */
const props = withDefaults(
  defineProps<{ cmd?: string; align?: 'center' | 'start' }>(),
  {
    cmd: 'npm install @adonisjs-lasagna/saas-tenancy',
    align: 'center',
  }
)

const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.cmd)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* no clipboard available; nothing to do */
  }
}
</script>

<template>
  <div :class="['cc', { 'cc--start': align === 'start' }]">
    <div class="cc__box" role="group" aria-label="Install command">
      <span class="cc__prompt" aria-hidden="true">$</span>
      <code class="cc__cmd">{{ cmd }}</code>
      <button
        type="button"
        class="cc__copy"
        :aria-label="copied ? 'Copied to clipboard' : 'Copy install command'"
        @click="copy"
      >
        <svg v-if="copied" class="cc__glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path d="M13 4 L6.5 11 L3 7.5" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else class="cc__glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.5 5.5 V3.5 a1 1 0 0 0 -1 -1 H3 a1 1 0 0 0 -1 1 V10 a1 1 0 0 0 1 1 h2"
                fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        <span class="cc__copylabel">{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cc {
  max-width: 1152px;
  margin: 0.5rem auto 0;
  padding: 0 24px;
  display: flex;
  justify-content: center;
}
.cc--start {
  max-width: none;
  margin: 0;
  padding: 0;
  justify-content: flex-start;
}
.cc__box {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  max-width: 100%;
  padding: 0.55rem 0.6rem 0.55rem 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  overflow-x: auto;
}
.cc__prompt {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  flex-shrink: 0;
}
.cc__cmd {
  color: var(--vp-c-text-1);
  white-space: nowrap;
  background: none;
  padding: 0;
  border: 0;
}
.cc__copy {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.cc__copy:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.cc__glyph {
  display: block;
}
@media (max-width: 480px) {
  .cc__copylabel {
    display: none;
  }
}
</style>
