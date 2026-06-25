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
  PhChartPieSlice,
} from '@phosphor-icons/vue'

/**
 * "One small core, orbited by its satellites" — the landing's signature
 * architecture visual.
 *
 * A compact medallion echo of the hero's lasagna slab sits at the centre; two
 * orbit rings carry meaning (inner = capabilities bundled with core, outer =
 * installable @adonisjs-lasagna/* packages). Satellites are fixed, labelled
 * chips; "aliveness" comes from a drifting aura, a slow radar sweep, flowing
 * ring dashes, and signal particles travelling each connector inward, so
 * nothing the eye must read ever moves.
 *
 * SSR-safe: positions are computed deterministically with Math in setup (no
 * browser APIs). All motion is gated:
 *   - SMIL particles + the orbiting moon are JS-gated behind `motionOK` (the
 *     global prefers-reduced-motion CSS rule does not reach SMIL);
 *   - the one-time scroll entrance only ever applies its hidden "from" state
 *     while the stage is off-screen (`armed` set when not intersecting), so
 *     SSR / no-JS / reduced-motion always render the final, visible state with
 *     no flash.
 */
interface Sat {
  id: string
  label: string
  desc: string
  tier: 'bundled' | 'package'
  icon: Component
  href: string
  /** The one-liner shown in the caption card; omitted for core-resident pieces. */
  cmd?: string
}
interface Placed extends Sat {
  x: number
  y: number
  left: string
  top: string
  d: string
  dur: string
  begin: string
  idx: number
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
    href: withBase('/guides/satellites/audit'),
    desc: 'Structured audit trail with actor and payload, queryable by date range.',
    cmd: 'node ace configure --with=audit',
  },
  {
    id: 'feature-flags',
    label: 'Feature flags',
    tier: 'bundled',
    icon: PhFlag,
    href: withBase('/guides/satellites/feature-flags'),
    desc: 'Per-tenant boolean flags (kill switches, beta cohorts), cached.',
    cmd: 'node ace configure --with=feature_flags',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    tier: 'bundled',
    icon: PhBroadcast,
    href: withBase('/guides/satellites/webhooks'),
    desc: 'HMAC-signed outbound events with a delivery state machine and retries.',
    cmd: 'node ace configure --with=webhooks',
  },
  {
    id: 'branding',
    label: 'Branding',
    tier: 'bundled',
    icon: PhPalette,
    href: withBase('/guides/satellites/branding'),
    desc: 'Per-tenant logo, colors, custom domain, and encrypted SMTP.',
    cmd: 'node ace configure --with=branding',
  },
  {
    id: 'metrics',
    label: 'Metrics',
    tier: 'bundled',
    icon: PhChartLine,
    href: withBase('/guides/satellites/metrics'),
    desc: 'Time-series counters per tenant with cursor-based aggregation.',
    cmd: 'node ace configure --with=metrics',
  },
  {
    id: 'quotas',
    label: 'Quotas',
    tier: 'bundled',
    icon: PhGauge,
    href: withBase('/guides/satellites/quotas'),
    desc: 'Plan-bound limits, rolling and snapshot, served as middleware.',
    cmd: 'node ace configure --with=quotas',
  },
  {
    id: 'impersonation',
    label: 'Impersonation',
    tier: 'bundled',
    icon: PhUserSwitch,
    href: withBase('/guides/satellites/impersonation'),
    desc: 'Admin enters a tenant as a target user, time-boxed and audited. Ships with the core.',
  },
]

// Outer ring — installable packages (`@adonisjs-lasagna/*`). Order is tuned so
// the short labels (SSO, Backup) fall on the spokes that sit closest to an inner
// chip, keeping all twelve labels clear of one another.
const packaged: Sat[] = [
  {
    id: 'websockets',
    label: 'WebSockets',
    tier: 'package',
    icon: PhPlugsConnected,
    href: withBase('/guides/satellites/websockets'),
    desc: 'Bidirectional socket.io, tenant-isolated per connection.',
    cmd: 'npm i @adonisjs-lasagna/websockets',
  },
  {
    id: 'sso',
    label: 'SSO',
    tier: 'package',
    icon: PhKey,
    href: withBase('/guides/satellites/sso'),
    desc: 'Per-tenant OIDC config with JWKS-backed verification.',
    cmd: 'npm i @adonisjs-lasagna/sso',
  },
  {
    id: 'reporting',
    label: 'Reporting',
    tier: 'package',
    icon: PhChartPieSlice,
    href: withBase('/guides/satellites/reporting'),
    desc: 'Cross-tenant analytics over the backoffice schema: usage by period, top-N tenants, custom metrics, and a mountable dashboard.',
    cmd: 'npm i @adonisjs-lasagna/reporting',
  },
  {
    id: 'backup',
    label: 'Backup',
    tier: 'package',
    icon: PhCloudArrowUp,
    href: withBase('/guides/satellites/backup'),
    desc: 'Per-tenant backup, restore, clone, and SQL import via pg_dump and pg_restore.',
    cmd: 'npm i @adonisjs-lasagna/backup',
  },
  {
    id: 'billing',
    label: 'Billing',
    tier: 'package',
    icon: PhCreditCard,
    href: withBase('/guides/satellites/billing'),
    desc: 'Multi-provider Stripe, Paddle, and Lemon Squeezy, with idempotent webhooks and dunning.',
    cmd: 'npm i @adonisjs-lasagna/billing',
  },
]

// viewBox geometry (resolution-independent; chips map the same square via %).
const C = 500
const R_INNER = 300
const R_OUTER = 440
const CORE_EDGE = 165 // connectors stop at the medallion's rim

function place(list: Sat[], radius: number, startDeg: number, idxBase: number): Placed[] {
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
      idx: idxBase + i,
    }
  })
}

// Inner from the top; outer offset so the five packages thread the inner spokes.
const innerPlaced = place(bundled, R_INNER, -90, 0)
const outerPlaced = place(packaged, R_OUTER, -54, bundled.length)
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

// Particles + moon are SSR-omitted; enabled on mount only when motion is allowed
// and the visual is on screen (the global reduced-motion CSS rule cannot stop SMIL).
const motionOK = ref(false)
const inView = ref(false)
const armed = ref(false) // hidden "from" state — only ever set while off-screen
const revealed = ref(false) // entrance done / final state (latches once)
const stage = ref<HTMLElement | null>(null)
const showParticles = computed(() => motionOK.value && inView.value)
let io: IntersectionObserver | null = null

onMounted(() => {
  motionOK.value = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!motionOK.value || typeof IntersectionObserver === 'undefined' || !stage.value) {
    inView.value = true
    revealed.value = true // no entrance; render the final state outright
    return
  }
  io = new IntersectionObserver(
    ([e]) => {
      inView.value = e.isIntersecting
      if (e.isIntersecting) revealed.value = true
      else if (!revealed.value) armed.value = true
    },
    { rootMargin: '0px 0px -12% 0px' }
  )
  io.observe(stage.value)
})
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <section class="orbit" aria-labelledby="orbit-title">
    <header class="orbit__head">
      <p class="orbit__eyebrow">Core + satellites</p>
      <h2 id="orbit-title" class="orbit__title">One small core. Everything else orbits it.</h2>
      <p class="orbit__lede">
        Lasagna is a stable, battle-tested tenancy engine. Audit, billing, SSO, reporting and more
        are optional satellites: each tenant turns on what it needs, and nothing it doesn't.
      </p>
    </header>

    <div
      ref="stage"
      class="orbit__stage"
      :class="{
        'is-core-active': coreHover,
        'is-sat-active': activeId,
        'is-armed': armed,
        'is-revealed': revealed,
      }"
    >
      <div class="orbit__aura" aria-hidden="true" />
      <div class="orbit__radar" aria-hidden="true" />

      <svg class="orbit__svg" viewBox="0 0 1000 1000" aria-hidden="true">
        <defs>
          <radialGradient id="orbit-conn" gradientUnits="userSpaceOnUse" cx="500" cy="500" r="440">
            <stop class="orbit__g0" offset="0" />
            <stop class="orbit__g1" offset="0.55" />
            <stop class="orbit__g2" offset="1" />
          </radialGradient>
          <filter id="orbit-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle class="orbit__guide" cx="500" cy="500" r="370" />

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
          :class="{ 'is-active': coreHover || activeId === s.id, 'is-dim': activeId && activeId !== s.id }"
          stroke="url(#orbit-conn)"
          :d="s.d"
        />

        <g v-if="showParticles" class="orbit__particles" filter="url(#orbit-glow)">
          <circle
            v-for="s in all"
            :key="'p-' + s.id"
            class="orbit__particle"
            :class="{ 'is-active': activeId === s.id, 'is-dim': activeId && activeId !== s.id }"
            :r="s.tier === 'bundled' ? 5 : 4.4"
          >
            <animateMotion :dur="s.dur" :begin="s.begin" repeatCount="indefinite">
              <mpath :href="'#conn-' + s.id" />
            </animateMotion>
          </circle>
        </g>

        <g v-if="showParticles" class="orbit__moon-g">
          <circle class="orbit__moon" filter="url(#orbit-glow)" cx="500" cy="248" r="5.5">
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 500 500"
              to="360 500 500"
              dur="22s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      </svg>

      <div class="orbit__core" @mouseenter="coreHover = true" @mouseleave="coreHover = false">
        <span class="orbit__halo" aria-hidden="true" />
        <span class="orbit__pulse" aria-hidden="true" />
        <span class="orbit__slab" aria-hidden="true">
          <span
            v-for="(t, i) in CORE_TONES"
            :key="i"
            class="orbit__sheet"
            :style="{ '--tone': t, '--i': i }"
          />
          <span class="orbit__shimmer" aria-hidden="true" />
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
              :style="{ '--x': s.left, '--y': s.top, '--idx': s.idx }"
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
                <span class="orbit__chip-token" aria-hidden="true">
                  <component :is="s.icon" :size="15" weight="regular" />
                </span>
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
              :style="{ '--x': s.left, '--y': s.top, '--idx': s.idx }"
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
                <span class="orbit__chip-token" aria-hidden="true">
                  <component :is="s.icon" :size="15" weight="regular" />
                </span>
                <span class="orbit__chip-label">{{ s.label }}</span>
              </a>
              <span class="orbit__sat-desc">{{ s.desc }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="orbit__caption" aria-live="polite">
      <template v-if="active">
        <p class="orbit__cap-head">
          <span class="orbit__cap-name">{{ active.label }}</span>
          <span
            class="orbit__cap-tier"
            :class="active.tier === 'bundled' ? 'is-bundled' : 'is-pkg'"
            >{{ active.tier === 'bundled' ? 'bundled with core' : 'installable package' }}</span
          >
        </p>
        <p class="orbit__cap-desc">{{ active.desc }}</p>
        <code v-if="active.cmd" class="orbit__cap-cmd">
          <span class="orbit__cap-prompt" aria-hidden="true">›</span>{{ active.cmd }}
        </code>
      </template>
      <template v-else>
        <p class="orbit__cap-desc orbit__cap-desc--default">
          The core handles isolation, the resolver chain, context propagation, per-tenant pooling,
          and security boundaries. Always on. Hover a satellite to see what it adds.
        </p>
      </template>
    </div>

    <p class="orbit__legend" aria-hidden="true">
      <span class="orbit__legend-item">
        <span class="orbit__legend-token is-bundled" />Bundled with core
      </span>
      <span class="orbit__legend-item">
        <span class="orbit__legend-token is-pkg" />Installable package
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
  width: clamp(320px, 92vw, 700px);
  aspect-ratio: 1;
  margin: 0 auto;
}
.orbit__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  z-index: 1;
}

/* Atmosphere: a slow multi-tone aura + a faint radar sweep, both decorative,
   masked to the disc so the constellation dissolves into the page at its edge. */
.orbit__aura {
  position: absolute;
  inset: -4%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(26% 26% at 30% 30%, color-mix(in oklab, #c2410c 36%, transparent), transparent 70%),
    radial-gradient(24% 24% at 72% 28%, color-mix(in oklab, #0f6f86 30%, transparent), transparent 70%),
    radial-gradient(30% 30% at 70% 74%, color-mix(in oklab, #d97706 28%, transparent), transparent 72%),
    radial-gradient(26% 26% at 26% 72%, color-mix(in oklab, #3f7d8c 28%, transparent), transparent 70%);
  filter: blur(30px);
  opacity: 0.42;
  -webkit-mask: radial-gradient(circle at 50% 50%, #000 46%, transparent 72%);
  mask: radial-gradient(circle at 50% 50%, #000 46%, transparent 72%);
  animation: orbit-aura 26s ease-in-out infinite alternate;
}
.dark .orbit__aura {
  opacity: 0.55;
}
@keyframes orbit-aura {
  from {
    transform: rotate(0deg) scale(1);
  }
  to {
    transform: rotate(9deg) scale(1.06);
  }
}
.orbit__radar {
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(
    from 0deg,
    transparent 0 76%,
    color-mix(in oklab, var(--vp-c-brand-1) 14%, transparent) 90%,
    transparent 100%
  );
  -webkit-mask: radial-gradient(circle, transparent 55%, #000 58%, #000 87%, transparent 90%);
  mask: radial-gradient(circle, transparent 55%, #000 58%, #000 87%, transparent 90%);
  opacity: 0.5;
  animation: orbit-spin 17s linear infinite;
}
@keyframes orbit-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Faint static guide ring for depth between the two live rings. */
.orbit__guide {
  fill: none;
  stroke: var(--vp-c-divider);
  stroke-width: 1;
  opacity: 0.4;
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

/* Connectors + inbound signal particles. One radial gradient, centred on the
   core, fades every connector bright→faint from hub to rim. */
.orbit__g0 {
  stop-color: var(--vp-c-brand-1);
  stop-opacity: 0.85;
}
.orbit__g1 {
  stop-color: var(--vp-c-brand-1);
  stop-opacity: 0.34;
}
.orbit__g2 {
  stop-color: var(--vp-c-brand-1);
  stop-opacity: 0.06;
}
.orbit__conn {
  stroke-width: 1.5;
  stroke-linecap: round;
  opacity: 0.55;
  transition:
    opacity 0.3s ease,
    stroke-width 0.3s ease;
}
.orbit__conn.is-active {
  opacity: 1;
  stroke-width: 2.4;
}
.orbit__conn.is-dim {
  opacity: 0.18;
}
.orbit__particle {
  fill: var(--vp-c-brand-1);
  opacity: 0.78;
  transition: opacity 0.3s ease;
}
.orbit__particle.is-active {
  opacity: 1;
}
.orbit__particle.is-dim {
  opacity: 0.22;
}
.orbit__moon {
  fill: color-mix(in oklab, var(--vp-c-brand-1) 80%, #fff);
  opacity: 0.85;
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
  background: radial-gradient(circle at 50% 44%, var(--vp-c-brand-soft) 0%, transparent 68%);
  z-index: 2;
}
/* Slow breathing glow behind the slab. */
.orbit__halo {
  position: absolute;
  inset: -14%;
  border-radius: 50%;
  background: radial-gradient(
    circle at 50% 50%,
    color-mix(in oklab, var(--vp-c-brand-1) 26%, transparent) 0%,
    transparent 62%
  );
  opacity: 0.7;
  pointer-events: none;
  animation: orbit-breathe 6.5s ease-in-out infinite;
}
@keyframes orbit-breathe {
  0%,
  100% {
    transform: scale(0.94);
    opacity: 0.5;
  }
  50% {
    transform: scale(1.06);
    opacity: 0.85;
  }
}
.orbit__core::before {
  content: '';
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 24%, transparent);
  background: color-mix(in oklab, var(--vp-c-bg) 78%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, #fff 50%, transparent),
    0 18px 40px -22px color-mix(in oklab, var(--vp-c-brand-1) 55%, transparent);
  backdrop-filter: blur(2px);
  transition:
    border-color 0.3s ease,
    box-shadow 0.3s ease;
}
.orbit__stage.is-sat-active .orbit__core::before,
.orbit__core:hover::before {
  border-color: color-mix(in oklab, var(--vp-c-brand-1) 60%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, #fff 60%, transparent),
    0 0 30px -2px var(--vp-c-brand-soft),
    0 18px 40px -20px color-mix(in oklab, var(--vp-c-brand-1) 65%, transparent);
}
.orbit__pulse {
  position: absolute;
  inset: 4%;
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
    transform: scale(1.9);
    opacity: 0;
  }
}
.orbit__slab {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 62%;
  transform: rotate(-3deg);
  overflow: hidden;
  border-radius: 6px;
}
.orbit__sheet {
  height: 11px;
  border-radius: 4px;
  background: var(--tone);
  transform: translateX(calc((var(--i) % 2) * 6px - 3px));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.28),
    0 4px 10px -5px color-mix(in oklab, var(--tone) 60%, transparent);
}
/* A light reflection sweeping across the stacked sheets. */
.orbit__shimmer {
  position: absolute;
  inset: -20% -40%;
  background: linear-gradient(
    74deg,
    transparent 38%,
    rgba(255, 255, 255, 0.55) 50%,
    transparent 62%
  );
  transform: translateX(-120%);
  animation: orbit-shimmer 5.5s ease-in-out 1.2s infinite;
  pointer-events: none;
}
@keyframes orbit-shimmer {
  0% {
    transform: translateX(-120%);
  }
  26%,
  100% {
    transform: translateX(120%);
  }
}
.orbit__core-label {
  position: relative;
  z-index: 1;
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
  box-shadow: 0 0 8px var(--vp-c-brand-1);
}

/* ─── Satellite chips ───────────────────────────────────────────── */
.orbit__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.32rem 0.78rem 0.32rem 0.36rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: color-mix(in oklab, var(--vp-c-bg) 80%, transparent);
  backdrop-filter: blur(6px);
  color: var(--vp-c-text-1);
  font-size: 0.8rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, #fff 50%, transparent),
    0 2px 8px -4px rgba(0, 0, 0, 0.18);
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease,
    color 0.2s ease;
}
.orbit__chip-token {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  flex: none;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease;
}
.orbit__chip--bundled .orbit__chip-token {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.orbit__chip--package .orbit__chip-token {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.orbit__chip-label {
  line-height: 1;
}
.orbit__chip:hover,
.orbit__chip:focus-visible,
.orbit__chip.is-active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, #fff 55%, transparent),
    0 10px 24px -10px color-mix(in oklab, var(--vp-c-brand-1) 55%, transparent);
}
.orbit__chip:hover .orbit__chip-token,
.orbit__chip:focus-visible .orbit__chip-token,
.orbit__chip.is-active .orbit__chip-token {
  background: var(--vp-c-brand-1);
  border-color: transparent;
  color: #fff;
}

/* ─── Caption card ──────────────────────────────────────────────── */
.orbit__caption {
  max-width: 38rem;
  min-height: 7.2rem;
  margin: 2rem auto 0;
  padding: 1.1rem 1.3rem;
  text-align: center;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: color-mix(in oklab, var(--vp-c-bg-soft) 70%, transparent);
  box-shadow: 0 16px 40px -28px color-mix(in oklab, var(--vp-c-brand-1) 45%, transparent);
}
.orbit__cap-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  margin: 0 0 0.5rem;
}
.orbit__cap-name {
  color: var(--vp-c-text-1);
  font-weight: 700;
  font-size: 1.02rem;
  letter-spacing: -0.01em;
}
.orbit__cap-tier {
  display: inline-block;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1px solid transparent;
}
.orbit__cap-tier.is-bundled {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border-color: color-mix(in oklab, var(--vp-c-brand-1) 22%, transparent);
}
.orbit__cap-tier.is-pkg {
  color: var(--vp-c-text-2);
  border-color: var(--vp-c-divider);
}
.orbit__cap-desc {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.55;
}
.orbit__cap-desc--default {
  padding: 0.5rem 0;
}
.orbit__cap-cmd {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.85rem;
  padding: 0.4rem 0.8rem;
  border-radius: 8px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  color: var(--vp-c-text-1);
}
.orbit__cap-prompt {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

/* ─── Legend ────────────────────────────────────────────────────── */
.orbit__legend {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  margin: 1rem 0 0;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}
.orbit__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}
.orbit__legend-token {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  flex: none;
}
.orbit__legend-token.is-bundled {
  background: var(--vp-c-brand-soft);
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 40%, transparent);
}
.orbit__legend-token.is-pkg {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
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
  /* Focus mode: when one satellite or the core is engaged, quiet the rest. */
  .orbit__stage.is-sat-active .orbit__chip:not(.is-active) {
    opacity: 0.42;
    filter: saturate(0.6);
  }
  .orbit__stage.is-core-active .orbit__chip {
    border-color: color-mix(in oklab, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  }
}

/* ─── Mobile: vertical communication spine ──────────────────────── */
@media (max-width: 860px) {
  .orbit__svg,
  .orbit__radar {
    display: none;
  }
  .orbit__stage {
    width: 100%;
    max-width: 30rem;
    aspect-ratio: auto;
    display: flex;
    flex-direction: column;
  }
  .orbit__aura {
    inset: auto;
    top: -2rem;
    left: 50%;
    width: 18rem;
    height: 18rem;
    transform: translateX(-50%);
    animation: none;
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
    top: 0.7rem;
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
  .orbit__caption {
    min-height: 0;
  }
}

/* ─── Scroll-in entrance ────────────────────────────────────────────
 * The hidden "from" state is applied ONLY while the stage is off-screen
 * (`is-armed` without `is-revealed`), so SSR / no-JS / reduced-motion render
 * the final state with no flash. Satellites stagger outward along their spokes. */
.orbit__stage.is-armed:not(.is-revealed) .orbit__sat {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.55);
}
.orbit__stage.is-armed:not(.is-revealed) .orbit__core {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.7);
}
.orbit__stage.is-armed:not(.is-revealed) .orbit__ring,
.orbit__stage.is-armed:not(.is-revealed) .orbit__guide,
.orbit__stage.is-armed:not(.is-revealed) .orbit__conn,
.orbit__stage.is-armed:not(.is-revealed) .orbit__aura {
  opacity: 0;
}
.orbit__stage.is-revealed .orbit__sat {
  transition:
    opacity 0.6s ease,
    transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
  transition-delay: calc(var(--idx) * 55ms);
}
.orbit__stage.is-revealed .orbit__core {
  transition:
    opacity 0.7s ease,
    transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.orbit__stage.is-revealed .orbit__ring,
.orbit__stage.is-revealed .orbit__guide,
.orbit__stage.is-revealed .orbit__aura {
  transition: opacity 0.9s ease;
}
.orbit__stage.is-revealed .orbit__conn {
  transition: opacity 0.9s ease 0.15s;
}

@media (max-width: 860px) {
  .orbit__stage.is-armed:not(.is-revealed) .orbit__sat {
    transform: none;
  }
  .orbit__stage.is-armed:not(.is-revealed) .orbit__core {
    transform: none;
  }
}

/* SMIL particles + the moon are JS-gated; this stops the CSS keyframes too
   (the global rule in style.css also covers this, kept here for locality). */
@media (prefers-reduced-motion: reduce) {
  .orbit__ring,
  .orbit__pulse,
  .orbit__aura,
  .orbit__radar,
  .orbit__halo,
  .orbit__shimmer {
    animation: none;
  }
  .orbit__stage.is-armed:not(.is-revealed) .orbit__sat,
  .orbit__stage.is-armed:not(.is-revealed) .orbit__core,
  .orbit__stage.is-armed:not(.is-revealed) .orbit__ring,
  .orbit__stage.is-armed:not(.is-revealed) .orbit__guide,
  .orbit__stage.is-armed:not(.is-revealed) .orbit__conn,
  .orbit__stage.is-armed:not(.is-revealed) .orbit__aura {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}
</style>
