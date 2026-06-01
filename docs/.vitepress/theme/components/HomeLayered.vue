<script setup lang="ts">
import { ref, type Component } from 'vue'
import { withBase } from 'vitepress'
import {
  PhCopy,
  PhCheck,
  PhArrowRight,
  PhGithubLogo,
  PhStar,
  PhShieldCheck,
  PhChartLineUp,
  PhCookingPot,
} from '@phosphor-icons/vue'
import LayeredHero from './LayeredHero.vue'

/**
 * Marketing layout for the landing page. Composes the Lasagna identity
 * around three pillars (precision, plumbing, polish) and a copy-paste
 * install line. The layered hero is to the right on desktop, top on
 * mobile.
 */

const installCmd = 'npm install @adonisjs-lasagna/saas-tenancy'
const justCopied = ref(false)

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(installCmd)
    justCopied.value = true
    setTimeout(() => (justCopied.value = false), 1400)
  } catch {
    /* no clipboard, no problem */
  }
}

interface Pillar {
  title: string
  body: string
  icon: Component
  toneVar: string
}

const pillars: Pillar[] = [
  {
    title: 'Zellige-precision isolation',
    body: 'Each tenant lives in its own PostgreSQL schema, named, provisioned, and routed without a `tenant_id` ever leaving the package boundary.',
    icon: PhShieldCheck,
    toneVar: '--lg-accent',
  },
  {
    title: 'SaaS-ready operations',
    body: 'Circuit breakers, read replicas, audit logs, signed webhooks, scheduled backups with retention tiers, OpenTelemetry, Prometheus. None of it bolted on later.',
    icon: PhChartLineUp,
    toneVar: '--lg-accent-2',
  },
  {
    title: 'Chef-level tooling',
    body: 'A doctor command that fixes things. Thirty-two ace commands. A REST admin API with OpenAPI 3.1. Helm chart, Dockerfile, e2e suite — kitchen included.',
    icon: PhCookingPot,
    toneVar: '--lg-accent-soft',
  },
]
</script>

<template>
  <main class="hl">
    <!-- Hero -->
    <section class="hl-hero">
      <div class="hl-hero__copy">
        <p class="hl-eyebrow">
          <PhStar :size="14" weight="fill" /> AdonisJS · v0.2.2
        </p>
        <h1 class="hl-title">
          The only multi-tenant layer
          <span class="hl-title__accent">your AdonisJS app will ever need.</span>
        </h1>
        <p class="hl-lede">
          Hand-stacked, schema-isolated PostgreSQL tenants with the production
          plumbing your SaaS will eventually need — and the operational
          tooling you'd otherwise spend six months writing yourself.
        </p>

        <div class="hl-install" role="group" aria-label="Install command">
          <span class="hl-install__prompt" aria-hidden="true">▸</span>
          <code class="hl-install__cmd">{{ installCmd }}</code>
          <button
            type="button"
            class="hl-install__copy"
            :aria-label="justCopied ? 'Copied' : 'Copy install command'"
            @click="copyInstall"
          >
            <PhCheck v-if="justCopied" :size="16" weight="bold" />
            <PhCopy v-else :size="16" weight="regular" />
          </button>
        </div>

        <div class="hl-cta">
          <a class="hl-btn hl-btn--primary" :href="withBase('/quickstart')">
            Start building
            <PhArrowRight :size="16" weight="bold" />
          </a>
          <a class="hl-btn hl-btn--ghost" :href="withBase('/why')">
            Why Lasagna
          </a>
          <a
            class="hl-btn hl-btn--quiet"
            href="https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy"
            target="_blank"
            rel="noopener"
          >
            <PhGithubLogo :size="16" weight="regular" />
            View on GitHub
          </a>
        </div>
      </div>

      <div class="hl-hero__art">
        <LayeredHero />
      </div>
    </section>

    <!-- Pillars -->
    <section class="hl-pillars" aria-label="Product pillars">
      <article
        v-for="p in pillars"
        :key="p.title"
        class="hl-pillar"
        :style="{ '--pillar-tone': `var(${p.toneVar})` }"
      >
        <div class="hl-pillar__icon" aria-hidden="true">
          <component :is="p.icon" :size="22" weight="regular" />
        </div>
        <h3 class="hl-pillar__title">{{ p.title }}</h3>
        <p class="hl-pillar__body">{{ p.body }}</p>
      </article>
    </section>

    <!-- Quote / philosophy -->
    <section class="hl-quote">
      <blockquote>
        You know that moment in the kitchen when you lift the first layer of
        pasta and see every ingredient exactly where it belongs?
        <strong>That's what we built.</strong>
      </blockquote>
      <p class="hl-quote__attr">
        Each tenant is its own layer — isolated, secure, perfectly stacked
        over your AdonisJS foundation. Read the
        <a :href="withBase('/why')">full story</a>.
      </p>
    </section>

    <!-- Final CTA -->
    <section class="hl-final">
      <div class="hl-final__panel">
        <h2 class="hl-final__title">
          Build your first SaaS in thirty minutes.
        </h2>
        <p class="hl-final__body">
          The quickstart walks you from <code>npm install</code> to a live,
          schema-isolated tenant with audit logs, quotas, and a doctor
          report — without ever writing the words <code>tenant_id =</code>.
        </p>
        <a class="hl-btn hl-btn--primary hl-btn--lg" :href="withBase('/quickstart')">
          Open the quickstart
          <PhArrowRight :size="18" weight="bold" />
        </a>
      </div>
    </section>
  </main>
</template>

<style scoped>
.hl {
  max-width: 1200px;
  margin: 0 auto;
  padding: 4rem 1.25rem 6rem;
  color: var(--lg-text);
}

/* Hero ─────────────────────────────────────────────────────────── */
.hl-hero {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2.5rem;
  align-items: center;
  margin-bottom: 5rem;
}
@media (min-width: 900px) {
  .hl-hero {
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
    gap: 3.5rem;
  }
}
.hl-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--lg-font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--lg-accent);
  margin: 0 0 0.75rem;
}
.hl-title {
  font-family: var(--lg-font-serif);
  font-size: clamp(2rem, 4.6vw, 3.4rem);
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 0 0 1rem;
  color: var(--lg-text);
}
.hl-title__accent {
  display: block;
  color: var(--lg-accent);
  font-style: italic;
  font-weight: 500;
}
.hl-lede {
  font-size: 1.1rem;
  line-height: 1.55;
  color: var(--lg-text-muted);
  margin: 0 0 1.75rem;
  max-width: 30em;
}

.hl-install {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  background-color: var(--lg-code-bg);
  color: var(--lg-code-fg);
  border: 1px solid var(--lg-code-bg);
  border-radius: 12px;
  padding: 0.7rem 1rem;
  font-family: var(--lg-font-mono);
  font-size: 0.92rem;
  margin-bottom: 1.75rem;
  box-shadow: 0 1px 2px rgba(26, 15, 8, 0.06), 0 12px 32px -16px rgba(26, 15, 8, 0.4);
  max-width: 100%;
  overflow-x: auto;
}
.hl-install__prompt { color: var(--lg-accent); }
.hl-install__cmd { white-space: nowrap; }
.hl-install__copy {
  background: transparent;
  color: var(--lg-code-fg);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.hl-install__copy:hover { border-color: var(--lg-accent); color: #fff; }
.hl-install__copy[aria-label='Copied'] {
  border-color: var(--lg-accent);
  color: var(--lg-accent);
}

.hl-cta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.hl-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.625rem 1.125rem;
  border-radius: 999px;
  font-family: var(--lg-font-sans);
  font-weight: 500;
  font-size: 0.95rem;
  text-decoration: none;
  border: 1px solid transparent;
  transition: transform 200ms ease, background-color 200ms ease,
              color 200ms ease, border-color 200ms ease;
}
.hl-btn--primary {
  background-color: var(--lg-accent);
  color: #FFFAF6;
  border-color: var(--lg-accent);
}
.hl-btn--primary:hover {
  transform: translateY(-1px);
  background-color: var(--lg-accent-soft);
  border-color: var(--lg-accent-soft);
}
.hl-btn--ghost {
  background-color: transparent;
  color: var(--lg-accent-2);
  border-color: var(--lg-accent-2);
}
.hl-btn--ghost:hover {
  background-color: var(--lg-accent-2);
  color: var(--lg-bg);
}
.hl-btn--quiet {
  color: var(--lg-text-muted);
  background-color: transparent;
}
.hl-btn--quiet:hover { color: var(--lg-text); }
.hl-btn--lg { padding: 0.85rem 1.5rem; font-size: 1.05rem; }

.hl-hero__art {
  display: grid;
  place-items: center;
}

/* Pillars ──────────────────────────────────────────────────────── */
.hl-pillars {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
  margin-bottom: 5rem;
}
@media (min-width: 800px) {
  .hl-pillars { grid-template-columns: repeat(3, 1fr); }
}
.hl-pillar {
  --pillar-tone: var(--lg-accent);
  background-color: var(--lg-surface);
  border: 1px solid var(--lg-line);
  border-radius: 16px;
  padding: 1.75rem;
  position: relative;
  box-shadow: var(--lg-shadow-card);
  overflow: hidden;
  transition: transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease;
}
.hl-pillar:hover {
  transform: translateY(-2px);
  border-color: color-mix(in oklab, var(--pillar-tone) 30%, var(--lg-line));
  box-shadow:
    var(--lg-shadow-card),
    0 16px 36px -14px color-mix(in oklab, var(--pillar-tone) 40%, transparent);
}
.hl-pillar__icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 1.1rem;
  border-radius: 11px;
  color: var(--pillar-tone);
  background: color-mix(in oklab, var(--pillar-tone) 14%, var(--lg-surface));
  border: 1px solid color-mix(in oklab, var(--pillar-tone) 20%, var(--lg-line));
}
.hl-pillar__title {
  font-family: var(--lg-font-sans);
  font-size: 1.08rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 0 0 0.55rem;
  color: var(--lg-text);
}
.hl-pillar__body {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--lg-text-muted);
}

/* Quote ───────────────────────────────────────────────────────── */
.hl-quote {
  max-width: 780px;
  margin: 5rem auto;
  padding: 0 1rem;
  text-align: center;
}
.hl-quote blockquote {
  font-family: var(--lg-font-serif);
  font-style: italic;
  font-size: clamp(1.25rem, 2.4vw, 1.65rem);
  line-height: 1.45;
  color: var(--lg-text);
  margin: 0 0 1rem;
}
.hl-quote blockquote strong {
  font-style: normal;
  color: var(--lg-accent);
  font-weight: 600;
}
.hl-quote__attr {
  color: var(--lg-text-muted);
  margin: 0;
}
.hl-quote__attr a { color: var(--lg-accent); }

/* Final CTA ───────────────────────────────────────────────────── */
.hl-final { margin-top: 4rem; }
.hl-final__panel {
  background:
    linear-gradient(135deg, rgba(194,106,75,0.08) 0%, rgba(42,107,124,0.08) 100%),
    var(--lg-surface);
  border: 1px solid var(--lg-line);
  border-radius: 18px;
  padding: clamp(2rem, 5vw, 3rem);
  text-align: center;
  position: relative;
  overflow: hidden;
}
.hl-final__panel::after {
  content: '';
  position: absolute;
  inset: 0;
  background: url('../assets/patterns/tile-border.svg') repeat;
  background-size: 100px;
  opacity: 0.4;
  pointer-events: none;
  z-index: 0;
}
.hl-final__panel > * { position: relative; z-index: 1; }
.hl-final__title {
  font-family: var(--lg-font-serif);
  font-size: clamp(1.6rem, 3.2vw, 2.2rem);
  font-weight: 600;
  margin: 0 0 0.75rem;
  color: var(--lg-text);
}
.hl-final__body {
  max-width: 50ch;
  margin: 0 auto 1.5rem;
  color: var(--lg-text-muted);
  line-height: 1.6;
}
.hl-final__body code {
  font-family: var(--lg-font-mono);
  font-size: 0.9em;
  padding: 0.1em 0.3em;
  background-color: rgba(194, 106, 75, 0.12);
  color: var(--lg-accent);
  border-radius: 4px;
}
</style>
