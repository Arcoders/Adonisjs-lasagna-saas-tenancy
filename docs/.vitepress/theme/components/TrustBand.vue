<script setup lang="ts">
import { withBase } from 'vitepress'

/**
 * Compatibility + trust strip shown under the hero. Surfaces the runtime
 * matrix (which otherwise lived only on the production checklist) and the
 * stability of the core, then points at the security page. Styled entirely
 * with VitePress tokens so it tracks the active theme.
 */
const chips = [
  'AdonisJS 7',
  'Node ≥ 24',
  'PostgreSQL ≥ 14',
  'Redis ≥ 6',
  'MIT licensed',
]
</script>

<template>
  <section class="tb" aria-label="Compatibility and status">
    <div class="tb__inner">
      <ul class="tb__chips">
        <li v-for="c in chips" :key="c" class="tb__chip">{{ c }}</li>
        <li class="tb__chip tb__chip--status">
          <span class="tb__dot" aria-hidden="true"></span>
          Core: Release Candidate
        </li>
      </ul>
      <a class="tb__link" :href="withBase('/guides/security')">
        Hardened against real failure modes
        <span aria-hidden="true">&rarr;</span>
      </a>
    </div>
  </section>
</template>

<style scoped>
.tb {
  max-width: 1152px;
  margin: 2.5rem auto 0;
  padding: 0 24px;
}
.tb__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.75rem 1.5rem;
  padding: 1.1rem 1.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.tb__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.5rem 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tb__chip {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  padding: 0.25rem 0.65rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg);
  white-space: nowrap;
}
.tb__chip--status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.tb__dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
}
.tb__link {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  white-space: nowrap;
}
.tb__link:hover {
  text-decoration: underline;
}
</style>
