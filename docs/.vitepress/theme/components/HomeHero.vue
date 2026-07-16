<script setup lang="ts">
import { withBase } from 'vitepress'
import { PhStar, PhArrowRight, PhGithubLogo } from '@phosphor-icons/vue'
import CopyCommand from './CopyCommand.vue'
import HomeStack from './HomeStack.vue'

/**
 * Rich landing hero: eyebrow chip, a two-line headline whose second line is a
 * colour accent (not a flourish), a lede, the isolation-driver strip, the
 * copy-paste install line, CTAs, and the layered-stack visual to the right (top
 * on mobile). Replaces VitePress's native hero via the `home-hero-before` slot
 * (the native hero slots are nulled in index.ts).
 *
 * The headline leads with the capability, not the product name: the name
 * already sits in the nav bar, and infrastructure reads more credibly when it
 * states what it does first.
 *
 * The hero used to promise "every tenant in its own PostgreSQL schema", which
 * describes only `schema-pg`. Four drivers ship, so the copy names the storage
 * shapes and the strip below lists them. Keep this in step with
 * `docs/guides/data-isolation/index.md`, `HomeArchitecture`, and `HomeCta`.
 */
const drivers = [
  { name: 'schema-pg', tag: 'Default', href: withBase('/guides/data-isolation/schema-pg') },
  { name: 'database-pg', href: withBase('/guides/data-isolation/database-pg') },
  { name: 'rowscope-pg', href: withBase('/guides/data-isolation/rowscope-pg') },
  { name: 'sqlite-memory', tag: 'Tests', href: withBase('/guides/data-isolation/sqlite-memory') },
]
</script>

<template>
  <section class="hh">
    <div class="hh__inner">
      <div class="hh__copy">
        <p class="hh__eyebrow">
          <PhStar :size="13" weight="fill" />
          AdonisJS 7 · PostgreSQL · Four isolation drivers
        </p>

        <h1 class="hh__title">
          Multi-layer SaaS infrastructure.
          <span class="hh__accent">Isolate every tenant by schema, database, or row scope.</span>
        </h1>

        <p class="hh__lede">
          Routing, queues, quotas, backups, replicas, SSO, and billing, every
          one of them tenant-aware from the first request. The production
          plumbing a real SaaS needs, in one package.
        </p>

        <p class="hh__drivers">
          <span class="hh__drivers-label">Isolation drivers</span>
          <a
            v-for="d in drivers"
            :key="d.name"
            class="hh__driver"
            :class="{ 'is-default': d.tag === 'Default' }"
            :href="d.href"
          >
            {{ d.name }}
            <span v-if="d.tag" class="hh__driver-tag">{{ d.tag }}</span>
          </a>
        </p>

        <p class="hh__swap">
          One contract, four storage shapes. Pick a driver in one config line and your
          application code stays the same.
        </p>

        <CopyCommand class="hh__install" align="start" />

        <div class="hh__cta">
          <a class="hh__btn hh__btn--primary" :href="withBase('/start/quickstart')">
            Start building
            <PhArrowRight :size="16" weight="bold" />
          </a>
          <a class="hh__btn hh__btn--ghost" :href="withBase('/start/why')">Why Lasagna</a>
          <a
            class="hh__btn hh__btn--quiet"
            href="https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy"
            target="_blank"
            rel="noopener"
          >
            <PhGithubLogo :size="16" weight="regular" />
            View on GitHub
          </a>
        </div>
      </div>

      <div class="hh__art">
        <HomeStack />
      </div>
    </div>
  </section>
</template>

<style scoped>
.hh {
  position: relative;
  max-width: 1152px;
  margin: 0 auto;
  padding: 3.5rem 24px 1.5rem;
}
/* Soft brand glow behind the stack. */
.hh::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 55%;
  height: 100%;
  background: radial-gradient(
    50% 50% at 75% 35%,
    var(--vp-c-brand-soft) 0%,
    transparent 70%
  );
  pointer-events: none;
  z-index: 0;
}
/* Faint dot grid, fading toward the copy. */
.hh::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 42%;
  height: 100%;
  background-image: radial-gradient(var(--vp-c-divider) 1px, transparent 1px);
  background-size: 22px 22px;
  -webkit-mask-image: linear-gradient(to left, #000 0%, transparent 80%);
  mask-image: linear-gradient(to left, #000 0%, transparent 80%);
  opacity: 0.45;
  pointer-events: none;
  z-index: 0;
}
.hh__inner {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 1fr;
  gap: 2.5rem;
  align-items: center;
}
@media (min-width: 900px) {
  .hh__inner {
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
    gap: 3.5rem;
  }
}

.hh__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border: 1px solid color-mix(in oklab, var(--vp-c-brand-1) 22%, transparent);
  padding: 0.32rem 0.72rem;
  border-radius: 8px;
  margin: 0 0 1.25rem;
}
.hh__title {
  font-size: clamp(2.1rem, 4.8vw, 3.4rem);
  line-height: 1.07;
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0 0 1.1rem;
  color: var(--vp-c-text-1);
}
/* Subordinate to the headline: same voice, two thirds the size. At full size it
   ran three lines and out-weighed the statement above it. */
.hh__accent {
  display: block;
  margin-top: 0.35rem;
  color: var(--vp-c-brand-1);
  font-size: 0.66em;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.015em;
}
.hh__lede {
  font-size: 1.1rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 0.9rem;
  max-width: 34em;
}
/* ─── Isolation drivers strip ───────────────────────────────────────
 * Names the four shipped drivers so the hero never reads as "schema-pg only".
 * `sqlite-memory` carries its "Tests" tag on purpose: it is a testing-only
 * driver, and listing it unqualified would overclaim. */
.hh__drivers {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.5rem;
  margin: 0 0 0.75rem;
}
.hh__drivers-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin-right: 0.2rem;
}
.hh__driver {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: var(--vp-c-text-2);
  text-decoration: none;
  white-space: nowrap;
  transition: border-color 0.2s ease, color 0.2s ease;
}
.hh__driver:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.hh__driver.is-default {
  color: var(--vp-c-text-1);
  border-color: color-mix(in oklab, var(--vp-c-brand-1) 45%, var(--vp-c-divider));
}
.hh__driver-tag {
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.08rem 0.3rem;
  border-radius: 4px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}
.hh__driver.is-default .hh__driver-tag {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border-color: color-mix(in oklab, var(--vp-c-brand-1) 24%, transparent);
}

.hh__swap {
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0 0 1.4rem;
  max-width: 36em;
}

.hh__install {
  margin-bottom: 1.5rem;
}

.hh__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.hh__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.6rem 1.15rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.95rem;
  text-decoration: none;
  border: 1px solid transparent;
  transition: background-color 200ms ease, border-color 200ms ease,
    color 200ms ease, transform 200ms ease;
}
.hh__btn--primary {
  background: var(--lsg-c-ink);
  color: var(--lsg-c-on-ink);
  border-color: var(--lsg-c-ink);
}
.hh__btn--primary:hover {
  background: var(--lsg-c-ink-hover);
  border-color: var(--lsg-c-ink-hover);
  transform: translateY(-1px);
}
.hh__btn--ghost {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-divider);
}
.hh__btn--ghost:hover {
  border-color: var(--vp-c-brand-1);
}
.hh__btn--quiet {
  color: var(--vp-c-text-2);
}
.hh__btn--quiet:hover {
  color: var(--vp-c-text-1);
}

.hh__art {
  display: grid;
  place-items: center;
}
@media (max-width: 899px) {
  .hh__art {
    order: -1;
  }
}
</style>
