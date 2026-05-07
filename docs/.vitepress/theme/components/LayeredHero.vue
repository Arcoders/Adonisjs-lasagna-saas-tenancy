<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, type Component } from 'vue'
import {
  PhStack,
  PhMagicWand,
  PhGearSix,
  PhTriangle,
  PhDatabase,
} from '@phosphor-icons/vue'

/**
 * Stacked layer hero — five solid coloured "lasagna sheets" with a
 * numbered white badge, title, subtitle, and product glyph. Each sheet
 * uses one of the existing Zellige tones, lined up vertically with a
 * subtle horizontal stagger so the stack reads like layers seen from
 * the side.
 *
 * GSAP is loaded lazily and only powers a small fade/lift on first
 * scroll-in. The static state already matches the design, so reduced
 * motion or SSR pass simply skips the animation.
 */

interface Layer {
  num: string
  title: string
  subtitle: string
  icon: Component
  toneVar: string
}

const layers: Layer[] = [
  {
    num: '01',
    title: 'Tenant schemas',
    subtitle: 'Isolated. Secure. Scalable.',
    icon: PhStack,
    toneVar: '--lg-accent',
  },
  {
    num: '02',
    title: 'Bootstrappers',
    subtitle: 'Spin up tenants in seconds.',
    icon: PhMagicWand,
    toneVar: '--lg-accent-2',
  },
  {
    num: '03',
    title: 'Operational services',
    subtitle: 'Jobs, backups, metrics, and more.',
    icon: PhGearSix,
    toneVar: '--lg-accent-soft',
  },
  {
    num: '04',
    title: 'AdonisJS 7',
    subtitle: 'Built for performance.',
    icon: PhTriangle,
    toneVar: '--lg-accent-2-soft',
  },
  {
    num: '05',
    title: 'PostgreSQL 14+',
    subtitle: 'Rock-solid foundation.',
    icon: PhDatabase,
    toneVar: '--lg-line-strong',
  },
]

const root = ref<HTMLElement>()
let ctx: any = null

onMounted(async () => {
  if (typeof window === 'undefined') return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (!root.value) return

  const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
    import('gsap'),
    import('gsap/ScrollTrigger'),
  ])
  gsap.registerPlugin(ScrollTrigger)

  ctx = gsap.context(() => {
    gsap.fromTo(
      root.value!.querySelectorAll<HTMLElement>('[data-layer]'),
      { y: 14, opacity: 0 },
      {
        y: 0,
        opacity: 1,
        duration: 0.55,
        ease: 'power2.out',
        stagger: 0.07,
        scrollTrigger: {
          trigger: root.value!,
          start: 'top 85%',
          once: true,
        },
      }
    )
  }, root.value)
})

onBeforeUnmount(() => {
  if (ctx) ctx.revert()
})
</script>

<template>
  <div ref="root" class="ll-stack" role="list"
       aria-label="Lasagna stack: tenant schemas, bootstrappers, operational services, AdonisJS, and PostgreSQL">
    <article
      v-for="(l, i) in layers"
      :key="l.num"
      class="ll-layer"
      data-layer
      role="listitem"
      :style="{
        '--layer-tone': `var(${l.toneVar})`,
        '--layer-i': i,
      }"
    >
      <div class="ll-layer__num" aria-hidden="true">{{ l.num }}</div>
      <div class="ll-layer__body">
        <h3 class="ll-layer__title">{{ l.title }}</h3>
        <p class="ll-layer__sub">{{ l.subtitle }}</p>
      </div>
      <div class="ll-layer__icon" aria-hidden="true">
        <component :is="l.icon" :size="22" weight="regular" />
      </div>
    </article>
  </div>
</template>

<style scoped>
.ll-stack {
  width: 100%;
  max-width: 540px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.ll-layer {
  display: grid;
  grid-template-columns: 44px 1fr 36px;
  align-items: center;
  column-gap: 1rem;
  padding: 1.05rem 1.2rem;
  background-color: var(--layer-tone);
  border-radius: 14px;
  color: #FFFFFF;
  /* Subtle alternating horizontal stagger for the "layers seen from the
     side" feel. Even-indexed layers nudge right, odd ones left. */
  transform: translateX(calc((var(--layer-i, 0) % 2) * 10px - 5px));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 12px 28px -10px color-mix(in oklab, var(--layer-tone) 55%, rgba(46, 26, 14, 0.4));
  transition: transform 220ms ease, box-shadow 220ms ease;
}
.ll-layer:hover {
  transform: translateX(calc((var(--layer-i, 0) % 2) * 10px - 5px)) translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 18px 36px -10px color-mix(in oklab, var(--layer-tone) 65%, rgba(46, 26, 14, 0.45));
}

.ll-layer__num {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
  color: color-mix(in oklab, var(--layer-tone) 78%, var(--lg-text));
  font-family: var(--lg-font-mono);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.ll-layer__body { min-width: 0; }
.ll-layer__title {
  font-family: var(--lg-font-sans);
  font-weight: 600;
  font-size: 1.02rem;
  letter-spacing: -0.015em;
  color: #FFFFFF;
  margin: 0 0 0.12rem;
  line-height: 1.2;
}
.ll-layer__sub {
  margin: 0;
  font-size: 0.84rem;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.4;
}

.ll-layer__icon {
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.92);
}

@media (max-width: 540px) {
  .ll-layer {
    grid-template-columns: 36px 1fr 28px;
    column-gap: 0.75rem;
    padding: 0.9rem 1rem;
    transform: none;
  }
  .ll-layer:hover {
    transform: translateY(-2px);
  }
  .ll-layer__num { width: 30px; height: 30px; font-size: 0.74rem; }
}

@media (prefers-reduced-motion: reduce) {
  .ll-layer { transition: none; }
}
</style>
