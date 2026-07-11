<script setup lang="ts">
import { withBase } from 'vitepress'
import { PhArrowRight } from '@phosphor-icons/vue'

/**
 * Closing call-to-action band at the foot of the landing page. Full-bleed,
 * brand-tinted, with a single primary action. Token-driven, so it tracks the
 * active theme.
 */
</script>

<template>
  <section class="cta">
    <div class="cta__inner">
      <h2 class="cta__title">Give every tenant real isolation.</h2>
      <p class="cta__lede">
        From <code>npm install</code> to a live, isolated tenant in under ten
        minutes. Start on <code>schema-pg</code> and change one config line if you
        ever outgrow it.
      </p>
      <a class="cta__btn" :href="withBase('/start/quickstart')">
        Start the quickstart
        <PhArrowRight :size="18" weight="bold" />
      </a>
    </div>
  </section>
</template>

<style scoped>
.cta {
  width: 100%;
  margin: 6rem 0 0;
  padding: 5.5rem 24px;
  background:
    radial-gradient(
      120% 140% at 50% 0%,
      var(--vp-c-brand-soft) 0%,
      transparent 70%
    ),
    var(--vp-c-bg-soft);
  border-top: 1px solid var(--vp-c-divider);
  text-align: center;
}
.cta__inner {
  max-width: 40rem;
  margin: 0 auto;
}
.cta__title {
  font-size: clamp(1.7rem, 4vw, 2.6rem);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.1;
  margin: 0 0 0.85rem;
  color: var(--vp-c-text-1);
}
.cta__lede {
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 auto 1.75rem;
  max-width: 32em;
}
.cta__lede code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
}
.cta__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.8rem 1.6rem;
  border-radius: 8px;
  background: var(--lsg-c-ink);
  color: var(--lsg-c-on-ink);
  font-weight: 600;
  font-size: 1.02rem;
  text-decoration: none;
  border: 1px solid var(--lsg-c-ink);
  transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}
.cta__btn:hover {
  background: var(--lsg-c-ink-hover);
  border-color: var(--lsg-c-ink-hover);
  transform: translateY(-1px);
}
</style>
