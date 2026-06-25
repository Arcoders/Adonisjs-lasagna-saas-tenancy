<script setup lang="ts">
import { withBase } from 'vitepress'

/**
 * "Who it's for / when not to use" band plus the load-bearing outbound links
 * (reference app, benchmarks, comparison). Honest framing is a trust signal:
 * a reader who shouldn't adopt the package should be able to tell at a glance.
 */
const reachFor = [
  'You run multiple paying tenants that each need hard data isolation.',
  'You want per-tenant backups, restore, and clone as first-class operations.',
  'You need SaaS plumbing — quotas, webhooks, SSO, billing — without assembling it yourself.',
  'PostgreSQL is your primary database.',
]

const lookElsewhere = [
  'Your app is single-tenant, or will stay that way.',
  'A single tenant_id column already covers your isolation needs.',
  'You are committed to MongoDB or another non-PostgreSQL store. (MySQL/MariaDB is on the roadmap as a future satellite.)',
  'You want a hosted control plane rather than a library in your app.',
]

const REPO = 'https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy'
const links = [
  { text: 'Reference app', sub: 'A real AdonisJS 7 app', href: `${REPO}/tree/master/examples/api`, external: true },
  { text: 'Benchmarks', sub: 'Numbers on real hardware', href: withBase('/guides/performance'), external: false },
  { text: 'Comparison', sub: 'vs stancl & NestJS', href: withBase('/reference/comparison'), external: false },
]
</script>

<template>
  <section class="ad" aria-label="Who it is for">
    <div class="ad__inner">
      <header class="ad__head">
        <p class="ad__eyebrow">Is it for you?</p>
        <h2 class="ad__title">Built for AdonisJS SaaS, honest about the rest</h2>
      </header>

      <div class="ad__cols">
        <div class="ad__col ad__col--yes">
          <h3 class="ad__h">Reach for Lasagna when</h3>
          <ul class="ad__list">
            <li v-for="r in reachFor" :key="r">{{ r }}</li>
          </ul>
        </div>
        <div class="ad__col ad__col--no">
          <h3 class="ad__h">Look elsewhere when</h3>
          <ul class="ad__list ad__list--muted">
            <li v-for="l in lookElsewhere" :key="l">{{ l }}</li>
          </ul>
        </div>
      </div>

      <div class="ad__links">
        <a
          v-for="link in links"
          :key="link.text"
          class="ad__link"
          :href="link.href"
          :target="link.external ? '_blank' : undefined"
          :rel="link.external ? 'noopener' : undefined"
        >
          <span class="ad__link-text">{{ link.text }}</span>
          <span class="ad__link-sub">{{ link.sub }}</span>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ad {
  max-width: 1152px;
  margin: 6rem auto 0;
  padding: 0 24px;
}
.ad__head {
  text-align: center;
  max-width: 46rem;
  margin: 0 auto 2.5rem;
}
.ad__eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 0.6rem;
}
.ad__title {
  font-size: clamp(1.5rem, 3.2vw, 2.1rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  line-height: 1.15;
}
.ad__cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
}
@media (min-width: 720px) {
  .ad__cols {
    grid-template-columns: 1fr 1fr;
  }
}
.ad__col {
  padding: 1.6rem 1.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}
.ad__col--yes {
  border-top: 3px solid var(--vp-c-brand-1);
}
.ad__col--no {
  border-top: 3px solid var(--vp-c-divider);
}
.ad__h {
  margin: 0 0 1rem;
  font-size: 1.05rem;
  font-weight: 600;
}
.ad__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.ad__list li {
  position: relative;
  padding-left: 1.5rem;
  color: var(--vp-c-text-1);
  font-size: 0.92rem;
  line-height: 1.5;
}
.ad__list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.5rem;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
}
.ad__list--muted li {
  color: var(--vp-c-text-2);
}
.ad__list--muted li::before {
  background: var(--vp-c-text-3);
}

.ad__links {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
  margin-top: 1.25rem;
}
@media (min-width: 560px) {
  .ad__links {
    grid-template-columns: repeat(3, 1fr);
  }
}
.ad__link {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 1rem 1.1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  text-decoration: none;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.ad__link:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}
.ad__link-text {
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.ad__link-sub {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
}
</style>
