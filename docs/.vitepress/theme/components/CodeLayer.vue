<script setup lang="ts">
import { ref } from 'vue'
import { PhCopy, PhCheck } from '@phosphor-icons/vue'

/**
 * A code-block surface with a textured tab strip and a copy button. Used
 * around the markdown's native code blocks via slot — the actual syntax
 * highlighting still comes from VitePress's Shiki integration.
 *
 * Authors invoke it as:
 *
 *   <CodeLayer label="bash" lang="bash">
 *
 *   ```bash
 *   node ace ...
 *   ```
 *
 *   </CodeLayer>
 *
 * The `lang` is purely cosmetic (it labels the tab); the highlighting
 * still happens inside the markdown fence.
 */
const props = withDefaults(
  defineProps<{
    label?: string
    lang?: string
  }>(),
  { label: '', lang: '' }
)

const justCopied = ref(false)
const root = ref<HTMLElement>()

async function copy() {
  const code = root.value?.querySelector('pre code')?.textContent ?? ''
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    justCopied.value = true
    setTimeout(() => (justCopied.value = false), 1400)
  } catch {
    /* no-op: browsers without clipboard support get a silent no-op */
  }
}
</script>

<template>
  <div ref="root" class="lg-codelayer">
    <div class="lg-codelayer__bar" :data-lang="lang">
      <span class="lg-codelayer__label">{{ label || lang || 'shell' }}</span>
      <button
        type="button"
        class="lg-codelayer__copy"
        :aria-label="justCopied ? 'Copied' : 'Copy code to clipboard'"
        @click="copy"
      >
        <PhCheck v-if="justCopied" :size="16" weight="bold" />
        <PhCopy v-else :size="16" weight="regular" />
      </button>
    </div>
    <div class="lg-codelayer__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.lg-codelayer {
  margin: 1.25rem 0;
  border-radius: 12px;
  border: 1px dashed var(--lg-line-strong);
  overflow: hidden;
  background-color: var(--lg-code-bg);
  box-shadow: var(--lg-shadow-card);
}
.lg-codelayer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.875rem;
  background-image:
    linear-gradient(0deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 100%),
    url('/patterns/tile-border.svg');
  background-size: auto, 80px;
  background-blend-mode: overlay;
  border-bottom: 1px dashed var(--lg-line-strong);
  color: var(--lg-accent-soft);
  font-family: var(--lg-font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.lg-codelayer__label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.lg-codelayer__label::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background-color: var(--lg-accent);
}
.lg-codelayer__copy {
  background: transparent;
  border: 1px solid transparent;
  color: var(--lg-accent-soft);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  transition: border-color 200ms ease, color 200ms ease;
}
.lg-codelayer__copy:hover {
  border-color: var(--lg-accent);
  color: var(--lg-code-fg);
}
.lg-codelayer__copy:active,
.lg-codelayer__copy[aria-label='Copied'] {
  color: var(--lg-accent);
  border-color: var(--lg-accent);
}
.lg-codelayer__body :deep(div[class*='language-']) {
  margin: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
</style>
