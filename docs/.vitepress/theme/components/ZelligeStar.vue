<script setup lang="ts">
/**
 * 8-point Zellige star. Inline SVG so colour/size override via the standard
 * CSS cascade. Used as a section ornament and inside the LasagnaCard
 * pasta-sheet edge.
 */
withDefaults(
  defineProps<{
    size?: number | string
    color?: string
  }>(),
  {
    size: 16,
    color: 'currentColor',
  }
)
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    role="presentation"
  >
    <path
      :fill="color"
      d="M12 0 L14 6 L20 4 L18 10 L24 12 L18 14 L20 20 L14 18 L12 24 L10 18 L4 20 L6 14 L0 12 L6 10 L4 4 L10 6 Z"
    />
  </svg>
</template>
