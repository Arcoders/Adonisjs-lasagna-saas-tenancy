<script setup lang="ts">
/**
 * The base surface element. Variants:
 *
 *  - `default`: thin top wave, neutral surface.
 *  - `accent`: terracotta wave + tinted background.
 *  - `feature`: larger wave, slightly elevated, used on landing pages.
 *
 * Authors typically pass body content + an optional `<template #title>`.
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
  background-color: var(--lg-surface);
  border: 1px solid var(--lg-line);
  border-radius: 12px;
  box-shadow: var(--lg-shadow-card);
  position: relative;
  overflow: hidden;
  margin: 1rem 0;
}
.lg-card::before {
  content: '';
  display: block;
  height: 6px;
  background: linear-gradient(
    90deg,
    var(--lg-accent) 0%,
    var(--lg-accent-2) 50%,
    var(--lg-accent) 100%
  );
  -webkit-mask: url('/patterns/wave.svg') repeat-x center / 24px 6px;
          mask: url('/patterns/wave.svg') repeat-x center / 24px 6px;
}
.lg-card--accent {
  background-color: rgba(194, 106, 75, 0.04);
  border-color: var(--lg-accent-soft);
}
.lg-card--feature::before {
  height: 10px;
}
.lg-card__body {
  padding: 1.25rem 1.5rem 1.5rem;
}
.lg-card__title {
  font-family: var(--lg-font-serif);
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
  color: var(--lg-text);
}
.lg-card__title:first-child {
  margin-top: 0;
}
</style>
