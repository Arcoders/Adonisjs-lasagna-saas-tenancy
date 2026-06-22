<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, type Component } from 'vue'
import { withBase } from 'vitepress'
import {
  PhScroll,
  PhFlag,
  PhBroadcast,
  PhPalette,
  PhChartLine,
  PhGauge,
  PhUserSwitch,
  PhKey,
  PhPlugsConnected,
  PhCreditCard,
  PhCloudArrowUp,
} from '@phosphor-icons/vue'

/**
 * "One small core, orbited by its satellites" — the landing's signature
 * architecture visual, replacing the flat feature grid.
 *
 * A compact medallion echo of the hero's lasagna slab sits at the centre; two
 * orbit rings carry meaning (inner = capabilities bundled with core, outer =
 * installable @adonisjs-lasagna/* packages). Satellites are fixed, labelled
 * chips; "aliveness" comes only from flowing ring dashes and signal particles
 * travelling each connector inward, so nothing the eye tracks ever moves.
 *
 * SSR-safe: positions are computed deterministically with Math in setup (no
 * browser APIs). SMIL particles are gated behind `motionOK` because the global
 * prefers-reduced-motion CSS rule does not reach SMIL; CSS animations and all
 * hover/focus states degrade through that rule on their own.
 */
interface Sat {
  id: string
  label: string
  desc: string
  tier: 'bundled' | 'package'
  icon: Component
  href: string
}
interface Placed extends Sat {
  x: number
  y: number
  left: string
  top: string
  d: string
  dur: string
  begin: string
}

// Compact core medallion: the hero slab's tones, shrunk to a hub.
const CORE_TONES = ['#c2410c', '#0f6f86', '#d97706', '#3f7d8c', '#8a5a3a']
const CAPABILITIES = [
  'Tenant isolation',
  'Resolver chain',
  'Context propagation',
  'Per-tenant connection pooling',
  'Contracts and security boundaries',
]

// Inner ring — bundled with core (`configure --with=<name>`).
const bundled: Sat[] = [
  {
    id: 'audit',
    label: 'Audit',
    tier: 'bundled',
    icon: PhScroll,
    href: withBase('/docs/satellites/audit'),
    desc: 'Structured audit trail with actor and payload, queryable by date range.',
  },
  {
    id: 'feature-flags',
    label: 'Feature flags',
    tier: 'bundled',
    icon: PhFlag,
    href: withBase('/docs/satellites/feature-flags'),
    desc: 'Per-tenant boolean flags (kill switches, beta cohorts), cached.',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    tier: 'bundled',
    icon: PhBroadcast,
    href: withBase('/docs/satellites/webhooks'),
    desc: 'HMAC-signed outbound events with a delivery state machine and retries.',
  },
  {
    id: 'branding',
    label: 'Branding',
    tier: 'bundled',
    icon: PhPalette,
    href: withBase('/docs/satellites/branding'),
    desc: 'Per-tenant logo, colors, custom domain, and encrypted SMTP.',
  },
  {
    id: 'metrics',
    label: 'Metrics',
    tier: 'bundled',
    icon: PhChartLine,
    href: withBase('/docs/satellites/metrics'),
    desc: 'Time-series counters per tenant with cursor-based aggregation.',
  },
  {
    id: 'quotas',
    label: 'Quotas',
    tier: 'bundled',
    icon: PhGauge,
    href: withBase('/docs/satellites/quotas'),
    desc: 'Plan-bound limits, rolling and snapshot, served as middleware.',
  },
  {
    id: 'impersonation',
    label: 'Impersonation',
    tier: 'bundled',
    icon: PhUserSwitch,
    href: withBase('/docs/satellites/impersonation'),
    desc: 'Admin enters a tenant as a target user, time-boxed and audited.',
  },
]

// Outer ring — installable packages (`@adonisjs-lasagna/*`).
const packaged: Sat[] = [
  {
    id: 'sso',
    label: 'SSO',
    tier: 'package',
    icon: PhKey,
    href: withBase('/docs/satellites/sso'),
    desc: 'Per-tenant OIDC config with JWKS-backed verification.',
  },
  {
    id: 'websockets',
    label: 'WebSockets',
    tier: 'package',
    icon: PhPlugsConnected,
    href: withBase('/docs/satellites/websockets'),
    desc: 'Bidirectional socket.io, tenant-isolated per connection.',
  },
  {
    id: 'billing',
    label: 'Billing',
    tier: 'package',
    icon: PhCreditCard,
    href: withBase('/docs/satellites/billing'),
    desc: 'Multi-provider Stripe, Paddle, and Lemon Squeezy, with idempotent webhooks and dunning.',
  },
  {
    id: 'backup',
    label: 'Backup',
    tier: 'package',
    icon: PhCloudArrowUp,
    href: withBase('/docs/satellites/backup'),
    desc: 'Per-tenant backup, restore, clone, and SQL import via pg_dump and pg_restore.',
  },
]

// viewBox geometry (resolution-independent; chips map the same square via %).
const C = 500
const R_INNER = 300
const R_OUTER = 440
const CORE_EDGE = 165 // connectors stop at the medallion's rim

function place(list: Sat[], radius: number, startDeg: number): Placed[] {
  const n = list.length
  return list.map((s, i) => {
    const rad = ((startDeg + (360 / n) * i) * Math.PI) / 180
    const x = C + radius * Math.cos(rad)
    const y = C + radius * Math.sin(rad)
    const ex = C + CORE_EDGE * Math.cos(rad)
    const ey = C + CORE_EDGE * Math.sin(rad)
    return {
      ...s,
      x,
      y,
      left: (x / 10).toFixed(2) + '%',
      top: (y / 10).toFixed(2) + '%',
      d: `M ${x.toFixed(1)} ${y.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}`,
      // Varied durations + negative (already-running) begins → a continuous,
      // unsynchronised trickle of signals into the core.
      dur: (2.8 + ((i * 0.43) % 1.3)).toFixed(2) + 's',
      begin: (-(i * 0.7)).toFixed(2) + 's',
    }
  })
}

// Outer ring is offset half a quadrant so packages sit between inner spokes.
const innerPlaced = place(bundled, R_INNER, -90)
const outerPlaced = place(packaged, R_OUTER, -45)
const all = [...innerPlaced, ...outerPlaced]

const activeId = ref<string | null>(null)
const coreHover = ref(false)
const active = computed(() => all.find((s) => s.id === activeId.value) ?? null)
const activeRing = computed(() =>
  active.value ? (active.value.tier === 'bundled' ? 'inner' : 'outer') : null
)

function activate(id: string) {
  activeId.value = id
}
function clear(id: string) {
  if (activeId.value === id) activeId.value = null
}

// Particles are SSR-omitted; enabled on mount only when motion is allowed and
// the visual is on screen (the global reduced-motion CSS rule cannot stop SMIL).
const motionOK = ref(false)
const inView = ref(false)
const stage = ref<HTMLElement | null>(null)
const showParticles = computed(() => motionOK.value && inView.value)
let io: IntersectionObserver | null = null

onMounted(() => {
  motionOK.value = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (typeof IntersectionObserver !== 'undefined' && stage.value) {
    io = new IntersectionObserver(([e]) => (inView.value = e.isIntersecting), {
      rootMargin: '0px 0px -10% 0px',
    })
    io.observe(stage.value)
  } else {
    inView.value = true
  }
})
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <section class="orbit" aria-labelledby="orbit-title">
    <header class="orbit__head">
      <p class="orbit__eyebrow">Core + satellites</p>
      <h2 id="orbit-title" class="orbit__title">One small core. Everything else orbits it.</h2>
      <p class="orbit__lede">
        Lasagna is a stable, battle-tested tenancy engine. Audit, billing, SSO, webhooks and more
        are optional satellites: each tenant turns on what it needs, and nothing it doesn't.
      </p>
    </header>

    <div
      ref="stage"
      class="orbit__stage"
      :class="{ 'is-core-active': coreHover, 'is-sat-active': activeId }"
    >
      <svg class="orbit__svg" viewBox="0 0 1000 1000" aria-hidden="true">
        <circle
          class="orbit__ring orbit__ring--inner"
          :class="{ 'is-active': coreHover || activeRing === 'inner' }"
          cx="500"
          cy="500"
          :r="R_INNER"
        />
        <circle
          class="orbit__ring orbit__ring--outer"
          :class="{ 'is-active': coreHover || activeRing === 'outer' }"
          cx="500"
          cy="500"
          :r="R_OUTER"
        />

        <path
          v-for="s in all"
          :id="'conn-' + s.id"
          :key="'c-' + s.id"
          class="orbit__conn"
          :class="{ 'is-active': coreHover || activeId === s.id }"
          :d="s.d"
        />

        <g v-if="showParticles" class="orbit__particles">
          <circle v-for="s in all" :key="'p-' + s.id" class="orbit__particle" r="5">
            <animateMotion :dur="s.dur" :begin="s.begin" repeatCount="indefinite">
              <mpath :href="'#conn-' + s.id" />
            </animateMotion>
          </circle>
        </g>
      </svg>

      <div class="orbit__core" @mouseenter="coreHover = true" @mouseleave="coreHover = false">
        <span class="orbit__pulse" aria-hidden="true" />
        <span class="orbit__slab" aria-hidden="true">
          <span
            v-for="(t, i) in CORE_TONES"
            :key="i"
            class="orbit__sheet"
            :style="{ '--tone': t, '--i': i }"
          />
        </span>
        <span class="orbit__core-label">
          <span class="orbit__core-dot" aria-hidden="true" />Lasagna core
        </span>
      </div>

      <div class="orbit__groups">
        <div class="orbit__group">
          <h3 class="orbit__group-title">Bundled with core</h3>
          <ul class="orbit__sats">
            <li
              v-for="s in innerPlaced"
              :key="s.id"
              class="orbit__sat"
              :style="{ '--x': s.left, '--y': s.top }"
            >
              <a
                class="orbit__chip orbit__chip--bundled"
                :class="{ 'is-active': activeId === s.id }"
                :href="s.href"
                :aria-describedby="'d-' + s.id"
                @mouseenter="activate(s.id)"
                @mouseleave="clear(s.id)"
                @focus="activate(s.id)"
                @blur="clear(s.id)"
              >
                <span class="orbit__chip-dot" aria-hidden="true" />
                <component
                  :is="s.icon"
                  class="orbit__chip-icon"
                  :size="17"
                  weight="regular"
                  aria-hidden="true"
                />
                <span class="orbit__chip-label">{{ s.label }}</span>
              </a>
              <span class="orbit__sat-desc">{{ s.desc }}</span>
            </li>
          </ul>
        </div>

        <div class="orbit__group">
          <h3 class="orbit__group-title">Installable packages</h3>
          <ul class="orbit__sats">
            <li
              v-for="s in outerPlaced"
              :key="s.id"
              class="orbit__sat"
              :style="{ '--x': s.left, '--y': s.top }"
            >
              <a
                class="orbit__chip orbit__chip--package"
                :class="{ 'is-active': activeId === s.id }"
                :href="s.href"
                :aria-describedby="'d-' + s.id"
                @mouseenter="activate(s.id)"
                @mouseleave="clear(s.id)"
                @focus="activate(s.id)"
                @blur="clear(s.id)"
              >
                <span class="orbit__chip-dot" aria-hidden="true" />
                <component
                  :is="s.icon"
                  class="orbit__chip-icon"
                  :size="17"
                  weight="regular"
                  aria-hidden="true"
                />
                <span class="orbit__chip-label">{{ s.label }}</span>
              </a>
              <span class="orbit__sat-desc">{{ s.desc }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <p class="orbit__caption" aria-live="polite">
      <template v-if="active">
        <strong class="orbit__caption-name">{{ active.label }}</strong>
        <span class="orbit__caption-tier">{{
          active.tier === 'bundled' ? 'bundled with core' : 'installable package'
        }}</span>
        <span class="orbit__caption-desc">{{ active.desc }}</span>
      </template>
      <template v-else>
        The core handles isolation, the resolver chain, context propagation, per-tenant pooling, and
        security boundaries. Always on.
      </template>
    </p>

    <p class="orbit__legend" aria-hidden="true">
      <span class="orbit__legend-item">
        <span class="orbit__legend-dot orbit__legend-dot--bundled" />Bundled with core
      </span>
      <span class="orbit__legend-item">
        <span class="orbit__legend-dot orbit__legend-dot--package" />Installable package
      </span>
    </p>

    <div class="orbit__sr">
      <p>Lasagna core, always on: {{ CAPABILITIES.join('; ') }}.</p>
      <p v-for="s in all" :id="'d-' + s.id" :key="'sr-' + s.id">
        {{ s.label }}, {{ s.tier === 'bundled' ? 'bundled with core' : 'installable package' }}:
        {{ s.desc }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.orbit {
  max-width: 1152px;
  margin: 6rem auto 0;
  padding: 0 24px;
}

/* ─── Header (matches the other Home* sections) ─────────────────── */
.orbit__head {
  text-align: center;
  max-width: 46rem;
  margin: 0 auto 2.5rem;
}
.orbit__eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 0.6rem;
}
.orbit__title {
  font-size: clamp(1.5rem, 3.2vw, 2.1rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 0 0 0.7rem;
  padding: 0;
  border: 0;
}
.orbit__lede {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

/* ─── Stage ─────────────────────────────────────────────────────── */
.orbit__stage {
  position: relative;
  width: clamp(320px, 92vw, 680px);
  aspect-ratio: 1;
  margin: 0 auto;
}
.orbit__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* Orbit rings: dashes flow (opposite directions), satellites stay put. */
.orbit__ring {
  fill: none;
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
  stroke-dasharray: 4 10;
  opacity: 0.9;
  transition:
    stroke 0.3s ease,
    opacity 0.3s ease;
}
.orbit__ring--inner {
  animation: orbit-dash 14s linear infinite;
}
.orbit__ring--outer {
  animation: orbit-dash-rev 20s linear infinite;
}
.orbit__ring.is-active {
  stroke: var(--vp-c-brand-1);
  opacity: 1;
}
@keyframes orbit-dash {
  to {
    stroke-dashoffset: -140;
  }
}
@keyframes orbit-dash-rev {
  to {
    stroke-dashoffset: 140;
  }
}

/* Connectors + inbound signal particles. */
.orbit__conn {
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
  opacity: 0.45;
  transition:
    stroke 0.3s ease,
    opacity 0.3s ease,
    stroke-width 0.3s ease;
}
.orbit__conn.is-active {
  stroke: var(--vp-c-brand-1);
  opacity: 1;
  stroke-width: 2;
}
.orbit__particle {
  fill: var(--vp-c-brand-1);
  opacity: 0.7;
}

/* ─── Core medallion (compact echo of the hero slab) ────────────── */
.orbit__core {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 33%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 45%, var(--vp-c-brand-soft) 0%, transparent 70%);
  z-index: 2;
}
.orbit__core::before {
  content: '';
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 22%, transparent);
  transition:
    border-color 0.3s ease,
    box-shadow 0.3s ease;
}
.orbit__stage.is-sat-active .orbit__core::before,
.orbit__core:hover::before {
  border-color: color-mix(in oklab, var(--vp-c-brand-1) 55%, transparent);
  box-shadow: 0 0 26px -4px var(--vp-c-brand-soft);
}
.orbit__pulse {
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  border: 1.5px solid var(--vp-c-brand-1);
  opacity: 0;
  pointer-events: none;
}
.orbit__core:hover .orbit__pulse {
  animation: orbit-pulse 1.1s ease-out;
}
@keyframes orbit-pulse {
  0% {
    transform: scale(0.82);
    opacity: 0.5;
  }
  100% {
    transform: scale(1.85);
    opacity: 0;
  }
}
.orbit__slab {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 62%;
  transform: rotate(-3deg);
}
.orbit__sheet {
  height: 11px;
  border-radius: 4px;
  background: var(--tone);
  transform: translateX(calc((var(--i) % 2) * 6px - 3px));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.25),
    0 4px 10px -5px color-mix(in oklab, var(--tone) 60%, transparent);
}
.orbit__core-label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(0.6rem, 1.5vw, 0.72rem);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-1);
  white-space: nowrap;
}
.orbit__core-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
}

/* ─── Satellite chips ───────────────────────────────────────────── */
.orbit__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.36rem 0.72rem 0.36rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.8rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    color 0.2s ease;
}
.orbit__chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: none;
}
.orbit__chip--bundled .orbit__chip-dot {
  background: var(--vp-c-brand-1);
}
.orbit__chip--package .orbit__chip-dot {
  background: transparent;
  border: 1.5px solid var(--vp-c-brand-1);
}
.orbit__chip-icon {
  flex: none;
  color: var(--vp-c-text-2);
  transition: color 0.2s ease;
}
.orbit__chip-label {
  line-height: 1;
}
.orbit__chip:hover,
.orbit__chip:focus-visible,
.orbit__chip.is-active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  box-shadow: 0 8px 20px -10px color-mix(in oklab, var(--vp-c-brand-1) 50%, transparent);
}
.orbit__chip:hover .orbit__chip-icon,
.orbit__chip:focus-visible .orbit__chip-icon,
.orbit__chip.is-active .orbit__chip-icon {
  color: var(--vp-c-brand-1);
}

/* ─── Caption + legend ──────────────────────────────────────────── */
.orbit__caption {
  max-width: 40rem;
  min-height: 3.2rem;
  margin: 1.75rem auto 0;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.55;
}
.orbit__caption-name {
  margin-right: 0.5rem;
  color: var(--vp-c-text-1);
  font-weight: 700;
}
.orbit__caption-tier {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 30%, transparent);
  border-radius: 999px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  vertical-align: middle;
}
.orbit__caption-desc {
  display: block;
  margin-top: 0.45rem;
}
.orbit__legend {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  margin: 0.9rem 0 0;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}
.orbit__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.orbit__legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}
.orbit__legend-dot--bundled {
  background: var(--vp-c-brand-1);
}
.orbit__legend-dot--package {
  background: transparent;
  border: 1.5px solid var(--vp-c-brand-1);
}

.orbit__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ─── Desktop: rings layout ─────────────────────────────────────── */
@media (min-width: 861px) {
  .orbit__groups,
  .orbit__group,
  .orbit__sats {
    display: contents;
  }
  .orbit__group-title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .orbit__sat {
    position: absolute;
    left: var(--x);
    top: var(--y);
    transform: translate(-50%, -50%);
    z-index: 3;
  }
  .orbit__sat-desc {
    display: none;
  }
  .orbit__chip:hover,
  .orbit__chip:focus-visible,
  .orbit__chip.is-active {
    transform: scale(1.08);
  }
  .orbit__stage.is-core-active .orbit__chip {
    border-color: color-mix(in oklab, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  }
}

/* ─── Mobile: vertical communication spine ──────────────────────── */
@media (max-width: 860px) {
  .orbit__svg {
    display: none;
  }
  .orbit__stage {
    width: 100%;
    max-width: 30rem;
    aspect-ratio: auto;
    display: flex;
    flex-direction: column;
  }
  .orbit__core {
    position: static;
    transform: none;
    width: clamp(150px, 52vw, 200px);
    aspect-ratio: 1;
    margin: 0 auto 2rem;
  }
  .orbit__groups {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }
  .orbit__group {
    position: relative;
    padding-left: 1.4rem;
  }
  .orbit__group::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 0.4rem;
    bottom: 0.4rem;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(
      to bottom,
      var(--vp-c-brand-1),
      color-mix(in oklab, var(--vp-c-brand-1) 20%, transparent)
    );
    opacity: 0.5;
  }
  .orbit__group-title {
    margin: 0 0 0.85rem;
    font-family: var(--vp-font-family-mono);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vp-c-brand-1);
  }
  .orbit__sats {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .orbit__sat {
    position: relative;
  }
  .orbit__sat::before {
    content: '';
    position: absolute;
    left: -1.4rem;
    top: 0.72rem;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--vp-c-bg);
    border: 2px solid var(--vp-c-brand-1);
  }
  .orbit__chip {
    width: 100%;
    justify-content: flex-start;
  }
  .orbit__sat-desc {
    display: block;
    margin: 0.35rem 0 0;
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--vp-c-text-2);
  }
}

/* SMIL particles are gated in JS; this stops CSS keyframes for completeness. */
@media (prefers-reduced-motion: reduce) {
  .orbit__ring,
  .orbit__pulse {
    animation: none;
  }
}
</style>
