<script setup lang="ts">
import { type Component } from 'vue'
import {
  PhStack,
  PhMagicWand,
  PhGearSix,
  PhTriangle,
  PhDatabase,
} from '@phosphor-icons/vue'

/**
 * The signature "lasagna stack" hero visual: five layered sheets, each a
 * distinct tone, read like layers seen from the side. Static with a hover
 * lift (no animation runtime). Tones are intentional hero-only accents; the
 * rest of the site stays on the single brand colour.
 */
interface Layer {
  num: string
  title: string
  subtitle: string
  icon: Component
  tone: string
}

const layers: Layer[] = [
  { num: '01', title: 'Tenant schemas', subtitle: 'Isolated, named, routed.', icon: PhStack, tone: '#c2410c' },
  { num: '02', title: 'Bootstrappers', subtitle: 'Cache, drive, mail, queue, scoped.', icon: PhMagicWand, tone: '#0f6f86' },
  { num: '03', title: 'Operational services', subtitle: 'Jobs, backups, metrics, doctor.', icon: PhGearSix, tone: '#d97706' },
  { num: '04', title: 'AdonisJS 7', subtitle: 'Providers, ace, container.', icon: PhTriangle, tone: '#3f7d8c' },
  { num: '05', title: 'PostgreSQL 14+', subtitle: 'Schemas are native here.', icon: PhDatabase, tone: '#8a5a3a' },
]
</script>

<template>
  <div class="hs" role="list" aria-label="The Lasagna stack">
    <article
      v-for="(l, i) in layers"
      :key="l.num"
      class="hs__layer"
      role="listitem"
      :style="{ '--tone': l.tone, '--i': i }"
    >
      <span class="hs__num" aria-hidden="true">{{ l.num }}</span>
      <span class="hs__body">
        <span class="hs__title">{{ l.title }}</span>
        <span class="hs__sub">{{ l.subtitle }}</span>
      </span>
      <span class="hs__icon" aria-hidden="true">
        <component :is="l.icon" :size="22" weight="regular" />
      </span>
    </article>
  </div>
</template>

<style scoped>
.hs {
  width: 100%;
  max-width: 460px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.hs__layer {
  display: grid;
  grid-template-columns: 40px 1fr 32px;
  align-items: center;
  column-gap: 0.9rem;
  padding: 1rem 1.15rem;
  border-radius: 14px;
  color: #fff;
  background: var(--tone);
  transform: translateX(calc((var(--i) % 2) * 10px - 5px));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 12px 26px -12px color-mix(in oklab, var(--tone) 60%, transparent);
  transition: transform 220ms ease, box-shadow 220ms ease;
}
.hs__layer:hover {
  transform: translateX(calc((var(--i) % 2) * 10px - 5px)) translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 18px 34px -12px color-mix(in oklab, var(--tone) 70%, transparent);
}
.hs__num {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
  color: color-mix(in oklab, var(--tone) 80%, #1a0f08);
  display: grid;
  place-items: center;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.hs__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.hs__title {
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.hs__sub {
  font-size: 0.82rem;
  color: rgba(255, 255, 255, 0.86);
  line-height: 1.35;
}
.hs__icon {
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.92);
}
@media (max-width: 520px) {
  .hs__layer {
    transform: none;
    grid-template-columns: 30px 1fr 26px;
    column-gap: 0.7rem;
    padding: 0.85rem 1rem;
  }
  .hs__layer:hover {
    transform: translateY(-2px);
  }
  .hs__num {
    width: 28px;
    height: 28px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hs__layer {
    transition: none;
  }
}
</style>
