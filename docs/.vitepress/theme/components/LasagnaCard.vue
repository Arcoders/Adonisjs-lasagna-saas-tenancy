<script setup lang="ts">
/**
 * Simple surface card used on the marketing pages (why / showcase / sponsor).
 * Variants tweak the top accent; styling uses VitePress tokens so it tracks
 * the active theme.
 *
 *  - `default`: neutral top border.
 *  - `accent`:  terracotta top border.
 *  - `feature`: thicker terracotta top border, for landing pages.
 */
withDefaults(
  defineProps<{
    variant?: 'default' | 'accent' | 'feature'
    title?: string
  }>(),
  { variant: 'default' }
)
</script>

<template>
  <div :class="['lg-card', `lg-card--${variant}`]">
    <div class="lg-card__body">
      <h3 v-if="title || $slots.title" class="lg-card__title">
        <slot name="title">{{ title }}</slot>
      </h3>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.lg-card {
  background-color: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--vp-c-divider);
  border-radius: 12px;
  margin: 1rem 0;
}
.lg-card--accent {
  border-top-color: var(--vp-c-brand-1);
}
.lg-card--feature {
  border-top-width: 4px;
  border-top-color: var(--vp-c-brand-1);
}
.lg-card__body {
  padding: 1.25rem 1.5rem 1.5rem;
}
.lg-card__title {
  font-size: 1.2rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
  color: var(--vp-c-text-1);
}
.lg-card__title:first-child {
  margin-top: 0;
}
</style>
