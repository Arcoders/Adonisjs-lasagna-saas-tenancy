<script setup lang="ts">
import { computed } from 'vue'
import {
  PhInfo,
  PhLightbulb,
  PhWarning,
  PhSeal,
} from '@phosphor-icons/vue'

/**
 * Callout panel that slides in from the left edge with a Zellige tile cut.
 * Replaces the default VitePress containers (`::: tip`, `::: warning`, …)
 * for cases that want more room or a custom title.
 */
const props = withDefaults(
  defineProps<{
    type?: 'note' | 'tip' | 'warning' | 'danger'
    title?: string
  }>(),
  { type: 'note' }
)

const icon = computed(() => {
  switch (props.type) {
    case 'tip':
      return PhLightbulb
    case 'warning':
      return PhWarning
    case 'danger':
      return PhSeal
    default:
      return PhInfo
  }
})

const fallbackTitle = computed(() => {
  switch (props.type) {
    case 'tip':
      return 'Tip'
    case 'warning':
      return 'Warning'
    case 'danger':
      return 'Caution'
    default:
      return 'Note'
  }
})
</script>

<template>
  <aside :class="['lg-callout', `lg-callout--${type}`]" role="note">
    <div class="lg-callout__icon" aria-hidden="true">
      <component :is="icon" weight="regular" :size="20" />
    </div>
    <div class="lg-callout__body">
      <p v-if="title || $slots.title" class="lg-callout__title">
        <slot name="title">{{ title || fallbackTitle }}</slot>
      </p>
      <div class="lg-callout__content">
        <slot />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.lg-callout {
  display: flex;
  gap: 0.875rem;
  align-items: flex-start;
  padding: 1rem 1.25rem;
  border-radius: 12px;
  border: 1px solid var(--lg-line);
  background-color: var(--lg-surface);
  border-left-width: 4px;
  margin: 1.25rem 0;
  position: relative;
  background-image: linear-gradient(135deg, rgba(255,255,255,0) 0%, var(--lg-line) 100%);
  background-size: 200% 200%;
  background-position: 0 0;
}
.lg-callout--note {
  border-left-color: var(--lg-accent-2);
}
.lg-callout--tip {
  border-left-color: var(--lg-accent);
}
.lg-callout--warning {
  border-left-color: var(--lg-accent-3);
}
.lg-callout--danger {
  border-left-color: var(--lg-accent);
}
.lg-callout__icon {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--lg-accent);
}
.lg-callout--note .lg-callout__icon { color: var(--lg-accent-2); }
.lg-callout--warning .lg-callout__icon { color: var(--lg-accent-3); }
.lg-callout--danger .lg-callout__icon { color: var(--lg-accent); }
.lg-callout__body { flex: 1 1 auto; }
.lg-callout__title {
  font-family: var(--lg-font-serif);
  font-weight: 600;
  font-size: 1rem;
  margin: 0 0 0.25rem;
  color: var(--lg-text);
}
.lg-callout__content :deep(p):last-child { margin-bottom: 0; }
.lg-callout__content :deep(p):first-child { margin-top: 0; }
</style>
