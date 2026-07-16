<script setup lang="ts">
import { withBase } from 'vitepress'
import { PhArrowRight } from '@phosphor-icons/vue'
import { data as contracts } from '../contracts.data'

/**
 * "Extensible by contract" band: the positioning statement that Lasagna's
 * feature surface is a public extension point, backed by the two version
 * integers that make the promise enforceable rather than aspirational.
 *
 * The integers come from `contracts.data.ts`, which parses them out of
 * `packages/core/src/sdk/` at build time, so this section cannot drift from the
 * code. A contained panel on purpose, so it does not compete with HomeCta, the
 * single full-bleed brand block that follows.
 *
 * Copy is kept in sync with `docs/guides/plugins.md`, `docs/guides/extensibility.md`,
 * and the sponsor "Build and share a satellite" bullet.
 */
const snippetLines = [
  '// providers/seat_limit_plugin.ts',
  'import {',
  '  definePlugin,',
  '  authorizer,',
  '  LASAGNA_PLUGIN_API_VERSION,',
  "} from '@adonisjs-lasagna/saas-tenancy/plugin'",
  '',
  'export default definePlugin({',
  "  name: 'seat-limit',",
  `  satelliteApi: ${contracts.satelliteApi},`,
  '  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,',
  '',
  '  authorizers: () => [',
  '    authorizer({',
  "      name: 'seat_limit',",
  '      authorize: async (ctx, tenant) =>',
  '        withinSeatLimit(tenant),',
  '    }),',
  '  ],',
  '})',
]

const cards = [
  {
    constant: 'SATELLITE_API_VERSION',
    value: contracts.satelliteApi,
    subpath: '@adonisjs-lasagna/saas-tenancy/sdk',
    governs:
      'The extension registries, the satellite manifest, and the provider lifecycle a satellite builds against.',
  },
  {
    constant: 'PLUGIN_API_CONTRACT_VERSION',
    value: contracts.pluginApi,
    subpath: '@adonisjs-lasagna/saas-tenancy/plugin',
    governs:
      'The shape of the definePlugin facade, which you declare as LASAGNA_PLUGIN_API_VERSION. Independent of the satellite ABI on purpose, so either can move without the other.',
  },
]

const rules = [
  {
    when: 'Newer than core',
    level: 'fail' as const,
    label: 'Fail',
    what: 'Refuses to wire. configure exits non-zero, and boot throws.',
  },
  {
    when: 'Older than core',
    level: 'warn' as const,
    label: 'Warn',
    what: 'Registers and runs degraded. Read the changelog before you ship it.',
  },
  {
    when: 'Equal',
    level: 'ok' as const,
    label: 'OK',
    what: 'Wires cleanly.',
  },
]

const seams = [
  'authorizers',
  'middleware',
  'requestMacros',
  'provides',
  'schedules',
  'provisionExtensions',
  'onDataChange',
  'permissions',
  'nativeAddons',
]

const links = [
  { text: 'Creating a satellite', href: withBase('/guides/cookbook/creating-a-satellite') },
  { text: 'Extensibility standard', href: withBase('/guides/extensibility') },
  { text: 'Contract versions', href: withBase('/reference/contract-versions') },
]
</script>

<template>
  <section class="ex" aria-labelledby="ex-title">
    <div class="ex__inner">
      <header class="ex__head">
        <p class="ex__eyebrow">Extensible by contract</p>
        <h2 id="ex-title" class="ex__title">You're not waiting on our roadmap.</h2>
        <p class="ex__lede">
          Lasagna keeps a small, hardened isolation core that we keep stable and keep fixing.
          Everything above it is a satellite, and satellites are a public extension point, not a
          closed list we control.
        </p>
        <p class="ex__lede">
          When your product needs something we don't ship, you build it as a satellite: private to
          your codebase or published to npm, installed through the same <code>configure</code>
          command that wires the official ones. Every official satellite is built on the same public
          <code>definePlugin</code> facade you would use, so there is no privileged internal API.
          What we build on, you build on.
        </p>
      </header>

      <div class="ex__grid">
        <div class="ex__pane">
          <p class="ex__pane-title">One file, one export</p>
          <pre class="ex__code"><code><span
            v-for="(line, i) in snippetLines"
            :key="i"
            class="ex__line"
            :class="{ 'is-comment': line.startsWith('//') }"
          >{{ line }}
</span></code></pre>
        </div>

        <div class="ex__pane">
          <p class="ex__pane-title">Two versioned axes</p>
          <ul class="ex__cards">
            <li v-for="c in cards" :key="c.constant" class="ex__card">
              <p class="ex__card-head">
                <code class="ex__card-name">{{ c.constant }}</code>
                <span class="ex__card-value">v{{ c.value }}</span>
              </p>
              <code class="ex__card-subpath">{{ c.subpath }}</code>
              <p class="ex__card-governs">{{ c.governs }}</p>
            </li>
          </ul>
        </div>
      </div>

      <div class="ex__rule">
        <p class="ex__pane-title">What happens when they disagree</p>
        <ul class="ex__rules">
          <li v-for="r in rules" :key="r.when" class="ex__rule-row">
            <span class="ex__rule-when">{{ r.when }}</span>
            <span class="ex__rule-level" :class="'is-' + r.level">{{ r.label }}</span>
            <span class="ex__rule-what">{{ r.what }}</span>
          </li>
        </ul>
        <p class="ex__note">
          An undeclared version behaves like an older one and warns. The same rule is enforced three
          times: at install by <code>configure</code>, at boot by
          <code>assertSatelliteApiCompatAtBoot</code> and <code>assertPluginApiCompatAtBoot</code>,
          and on demand by <code>plugin:doctor</code>.
        </p>
      </div>

      <div class="ex__seams">
        <p class="ex__pane-title">Declarative seams</p>
        <ul class="ex__seam-list">
          <li v-for="s in seams" :key="s" class="ex__seam">{{ s }}</li>
        </ul>
        <p class="ex__note">
          Plus the <code>bind</code>, <code>boot</code>, <code>ready</code>, <code>start</code>, and
          <code>shutdown</code> lifecycle hooks when a section cannot express what you need.
        </p>
      </div>

      <div class="ex__cta">
        <a class="ex__btn" :href="withBase('/guides/plugins')">
          Building a plugin
          <PhArrowRight :size="16" weight="bold" />
        </a>
        <a v-for="l in links" :key="l.text" class="ex__link" :href="l.href">{{ l.text }}</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ex {
  max-width: 1152px;
  margin: 6rem auto 0;
  padding: 0 24px;
}
.ex__inner {
  max-width: 62rem;
  margin: 0 auto;
  padding: 2.6rem 2rem;
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--vp-c-brand-1);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

/* ─── Header ────────────────────────────────────────────────────── */
.ex__head {
  text-align: center;
  max-width: 46rem;
  margin: 0 auto 2.5rem;
}
.ex__eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 0.6rem;
}
.ex__title {
  font-size: clamp(1.5rem, 3.2vw, 2.1rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 0 0 1.2rem;
  padding: 0;
  border: 0;
}
.ex__lede {
  font-size: 1.02rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0 auto 1.1rem;
  max-width: 42em;
}
.ex__lede:last-of-type {
  margin-bottom: 0;
}

code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
}

/* ─── Snippet + contract cards ──────────────────────────────────── */
.ex__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.75rem;
}
/* Grid items default to `min-width: auto`, so the snippet's longest line would
   stretch its track instead of scrolling inside its own box. */
.ex__pane {
  min-width: 0;
}
/* Two columns only once a pane is wide enough to hold the snippet without a
   scrollbar. Below this the panes stack at full width. */
@media (min-width: 960px) {
  .ex__grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
}
.ex__pane-title {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
  margin: 0 0 0.75rem;
}
.ex__code {
  margin: 0;
  padding: 1.1rem 1.2rem;
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  line-height: 1.6;
}
.ex__code code {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vp-c-text-1);
  font-size: inherit;
}
.ex__line.is-comment {
  color: var(--vp-c-text-3);
}

.ex__cards {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ex__card {
  padding: 1rem 1.15rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.ex__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 0.55rem;
}
.ex__card-name {
  padding: 0;
  border: 0;
  background: none;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  word-break: break-all;
}
.ex__card-value {
  flex: none;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.14rem 0.5rem;
  border-radius: 6px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 24%, transparent);
}
.ex__card-subpath {
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow-x: auto;
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
}
.ex__card-governs {
  margin: 0.6rem 0 0;
  font-size: 0.86rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

/* ─── Compatibility rule ────────────────────────────────────────── */
.ex__rule,
.ex__seams {
  margin-top: 2rem;
  padding-top: 1.75rem;
  border-top: 1px solid var(--vp-c-divider);
}
.ex__rules {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ex__rule-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.25rem 0.9rem;
  align-items: baseline;
  padding: 0.7rem 0.95rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
@media (min-width: 700px) {
  .ex__rule-row {
    grid-template-columns: 10rem 4.5rem 1fr;
  }
}
.ex__rule-when {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--vp-c-text-1);
}
.ex__rule-level {
  justify-self: start;
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.14rem 0.5rem;
  border-radius: 6px;
  border: 1px solid transparent;
}
.ex__rule-level.is-fail {
  color: var(--vp-c-danger-1);
  background: var(--vp-c-danger-soft);
}
.ex__rule-level.is-warn {
  color: var(--vp-c-warning-1);
  background: var(--vp-c-warning-soft);
}
.ex__rule-level.is-ok {
  color: var(--vp-c-text-2);
  border-color: var(--vp-c-divider);
}
.ex__rule-what {
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.ex__note {
  margin: 1rem 0 0;
  font-size: 0.86rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.ex__note code {
  font-size: 0.8em;
}

/* ─── Seams ─────────────────────────────────────────────────────── */
.ex__seam-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ex__seam {
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  color: var(--vp-c-text-1);
  padding: 0.28rem 0.6rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
}

/* ─── CTAs ──────────────────────────────────────────────────────── */
.ex__cta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.5rem;
  margin-top: 2rem;
  padding-top: 1.75rem;
  border-top: 1px solid var(--vp-c-divider);
}
.ex__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 1.4rem;
  border-radius: 8px;
  background: var(--lsg-c-ink);
  color: var(--lsg-c-on-ink);
  font-weight: 600;
  font-size: 0.98rem;
  text-decoration: none;
  border: 1px solid var(--lsg-c-ink);
  transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}
.ex__btn:hover {
  background: var(--lsg-c-ink-hover);
  border-color: var(--lsg-c-ink-hover);
  transform: translateY(-1px);
}
.ex__link {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}
.ex__link:hover {
  text-decoration: underline;
}
</style>
