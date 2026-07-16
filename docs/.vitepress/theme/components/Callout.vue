<script setup lang="ts">
import { computed } from 'vue'

/**
 * Thin wrapper that renders a VitePress-native custom block. We keep the
 * `<Callout type title>` authoring API used across the docs, but emit the
 * same markup and classes as `::: tip` / `::: warning` containers so callouts
 * inherit VitePress's built-in, theme-aware styling. No bespoke design.
 */
const props = withDefaults(
  defineProps<{
    type?: 'note' | 'tip' | 'info' | 'warning' | 'danger'
    title?: string
  }>(),
  { type: 'note' }
)

// VitePress ships info/tip/warning/danger blocks; map the legacy "note".
const blockClass = computed(() => (props.type === 'note' ? 'info' : props.type))

const fallbackTitle = computed(() => {
  switch (props.type) {
    case 'tip':
      return 'TIP'
    case 'warning':
      return 'WARNING'
    case 'danger':
      return 'DANGER'
    case 'info':
      return 'INFO'
    default:
      return 'NOTE'
  }
})
</script>

<template>
  <div class="custom-block" :class="blockClass">
    <p class="custom-block-title">{{ title || fallbackTitle }}</p>
    <slot />
  </div>
</template>
