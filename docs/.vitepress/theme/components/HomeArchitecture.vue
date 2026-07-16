<script setup lang="ts">
import { withBase } from 'vitepress'

/**
 * Presentational request-flow diagram, rendered as a full-bleed soft band so
 * it reads as a distinct section in the page rhythm. Plain HTML/CSS (no client
 * runtime); the live Mermaid version of this flow lives on the Concepts page.
 */
interface Stage {
  title: string
  sub: string
}

const stages: Stage[] = [
  { title: 'Request', sub: 'HTTP in' },
  { title: 'CustomDomain', sub: 'Host → tenant id' },
  { title: 'TenantGuard', sub: 'resolve · validate · memoize' },
  { title: 'RateLimit', sub: 'per-tenant bucket' },
  { title: 'Controller', sub: 'TenantBaseModel.query()' },
  { title: 'TenantAdapter', sub: 'picks the connection' },
]

// All four shipped drivers. `sqlite-memory` is testing-only and says so, rather
// than being omitted: the hero advertises four, so this must show four.
const drivers = [
  { name: 'schema-pg', target: 'tenant_<uuid> schema' },
  { name: 'database-pg', target: 'tenant database' },
  { name: 'rowscope-pg', target: 'shared schema + tenant_id' },
  { name: 'sqlite-memory', target: 'in-process, tests only' },
]
</script>

<template>
  <section class="ha" aria-label="Request flow architecture">
    <div class="ha__inner">
      <header class="ha__head">
        <p class="ha__eyebrow">How it works</p>
        <h2 class="ha__title">From request to the right connection</h2>
        <p class="ha__lede">
          Every request is resolved to a tenant once, then the active isolation
          driver decides which connection serves the query. Your code only ever
          calls <code>TenantBaseModel.query()</code>.
        </p>
      </header>

      <ol class="ha__flow">
        <template v-for="(s, i) in stages" :key="s.title">
          <li class="ha__stage">
            <span class="ha__stage-title">{{ s.title }}</span>
            <span class="ha__stage-sub">{{ s.sub }}</span>
          </li>
          <li v-if="i < stages.length - 1" class="ha__arrow" aria-hidden="true">→</li>
        </template>
      </ol>

      <div class="ha__split" aria-hidden="true">↓ active driver</div>

      <ul class="ha__drivers">
        <li v-for="d in drivers" :key="d.name" class="ha__driver">
          <span class="ha__driver-name">{{ d.name }}</span>
          <span class="ha__driver-target">{{ d.target }}</span>
        </li>
      </ul>

      <p class="ha__note">
        <code>AsyncLocalStorage</code> carries the active tenant id beyond the
        request, so queued jobs, logs, cache, and drive resolve the same tenant
        without threading it by hand.
        <a :href="withBase('/start/concepts')">See the full flow →</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.ha {
  width: 100%;
  margin: 6rem 0 0;
  padding: 5.5rem 0;
  background: var(--vp-c-bg-soft);
  border-top: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}
.ha__inner {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}
.ha__head {
  text-align: center;
  max-width: 46rem;
  margin: 0 auto 2.5rem;
}
.ha__eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 0.6rem;
}
.ha__title {
  font-size: clamp(1.5rem, 3.2vw, 2.1rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 0.7rem;
  line-height: 1.15;
}
.ha__lede {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
.ha__lede code,
.ha__note code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
}

.ha__flow {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  justify-content: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ha__stage {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.75rem 0.95rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  min-width: 9.5rem;
  flex: 1 1 9.5rem;
  max-width: 12rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.ha__stage-title {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--vp-c-text-1);
}
.ha__stage-sub {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-2);
  line-height: 1.35;
}
.ha__arrow {
  display: flex;
  align-items: center;
  color: var(--vp-c-brand-1);
  font-weight: 700;
  padding: 0 0.1rem;
}

.ha__split {
  text-align: center;
  margin: 1.5rem 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

.ha__drivers {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* Four drivers: two-up on tablets, four-up once there is room, so the fourth
   never strands itself on a row of its own. */
@media (min-width: 720px) {
  .ha__drivers {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (min-width: 980px) {
  .ha__drivers {
    grid-template-columns: repeat(4, 1fr);
  }
}
.ha__driver {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.ha__driver-name {
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
  color: var(--vp-c-brand-1);
  font-size: 0.9rem;
}
.ha__driver-target {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
}

.ha__note {
  margin: 2rem auto 0;
  max-width: 46rem;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.6;
}
.ha__note a {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.ha__note a:hover {
  text-decoration: underline;
}
</style>
