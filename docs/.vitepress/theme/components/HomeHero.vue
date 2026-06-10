<script setup lang="ts">
import { withBase } from 'vitepress'
import { PhStar, PhArrowRight, PhGithubLogo } from '@phosphor-icons/vue'
import CopyCommand from './CopyCommand.vue'
import HomeStack from './HomeStack.vue'

/**
 * Rich landing hero: eyebrow chip, a two-line headline with a serif-italic
 * accent, a lede, the copy-paste install line, CTAs, and the layered-stack
 * visual to the right (top on mobile). Replaces VitePress's native hero via
 * the `home-hero-before` slot (the native hero slots are nulled in index.ts).
 */
</script>

<template>
  <section class="hh">
    <div class="hh__inner">
      <div class="hh__copy">
        <p class="hh__eyebrow">
          <PhStar :size="13" weight="fill" />
          AdonisJS 7 · PostgreSQL · Schema-isolated
        </p>

        <h1 class="hh__title">
          The only multi-tenant layer
          <span class="hh__accent">your AdonisJS app will ever need.</span>
        </h1>

        <p class="hh__lede">
          Every tenant isolated in its own PostgreSQL schema, with the
          production plumbing a real SaaS needs: routing, queues, quotas,
          backups, replicas, SSO, and billing. One package.
        </p>

        <CopyCommand class="hh__install" align="start" />

        <div class="hh__cta">
          <a class="hh__btn hh__btn--primary" :href="withBase('/quickstart')">
            Start building
            <PhArrowRight :size="16" weight="bold" />
          </a>
          <a class="hh__btn hh__btn--ghost" :href="withBase('/why')">Why Lasagna</a>
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
  border-radius: 999px;
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
.hh__accent {
  display: block;
  color: var(--vp-c-brand-1);
  font-weight: 500;
  font-style: italic;
  font-family: Georgia, 'Times New Roman', serif;
  letter-spacing: -0.01em;
}
.hh__lede {
  font-size: 1.1rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 1.5rem;
  max-width: 34em;
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
  border-radius: 999px;
  font-weight: 600;
  font-size: 0.95rem;
  text-decoration: none;
  border: 1px solid transparent;
  transition: background-color 200ms ease, border-color 200ms ease,
    color 200ms ease, transform 200ms ease;
}
.hh__btn--primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
.hh__btn--primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
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
