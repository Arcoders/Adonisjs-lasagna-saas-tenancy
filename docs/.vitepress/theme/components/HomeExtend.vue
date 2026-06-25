<script setup lang="ts">
import { withBase } from 'vitepress'
import { PhArrowRight } from '@phosphor-icons/vue'

/**
 * "Extend it yourself" band: the positioning statement that Lasagna's feature
 * surface is a public extension point, so adopters are not blocked on the
 * maintainers' roadmap. Mirrors HomeAdoption's contained, token-driven styling
 * and sits just before the closing CTA. A contained panel on purpose, so it
 * does not compete with HomeCta, the single full-bleed brand block that follows.
 *
 * Copy is kept in sync with the showcase "Build it your way" section and the
 * sponsor "Build and share a satellite" bullet.
 */
</script>

<template>
  <section class="ex" aria-label="Extend it yourself">
    <div class="ex__inner">
      <p class="ex__eyebrow">Extend it yourself</p>
      <h2 class="ex__title">You're not waiting on our roadmap.</h2>
      <p class="ex__lede">
        Lasagna keeps a small, hardened isolation core that we keep stable and
        keep fixing. Everything above it is a satellite, and satellites are a
        public extension point, not a closed list we control.
      </p>
      <p class="ex__lede">
        If your product needs something we don't ship, you don't wait for it on
        our roadmap. You build it as a satellite, keep it private to your
        codebase or publish it to npm for the community, and install it through
        the same <code>configure</code> command that wires the official ones.
        Billing and SSO ship exactly this way, so there is no privileged
        internal API: what we build on, you build on.
      </p>
      <a class="ex__btn" :href="withBase('/guides/cookbook/creating-a-satellite')">
        Creating a satellite
        <PhArrowRight :size="16" weight="bold" />
      </a>
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
  max-width: 52rem;
  margin: 0 auto;
  padding: 2.6rem 2rem;
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--vp-c-brand-1);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  text-align: center;
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
}
.ex__lede {
  font-size: 1.02rem;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0 auto 1.1rem;
  max-width: 42em;
}
.ex__lede:last-of-type {
  margin-bottom: 1.8rem;
}
.ex__lede code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
}
.ex__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 1.4rem;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
  font-size: 0.98rem;
  text-decoration: none;
  border: 1px solid var(--vp-c-brand-1);
  transition: background-color 0.2s ease, transform 0.2s ease;
}
.ex__btn:hover {
  background: var(--vp-c-brand-2);
  transform: translateY(-1px);
}
</style>
