<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PhCheck,
  PhX,
  PhMinus,
  PhQuestion,
  PhTrophy,
  PhMagnifyingGlass,
} from '@phosphor-icons/vue'
import data from '../../../data/comparison.json'

type Mark = 'yes' | 'partial' | 'no' | 'unknown'

interface Row {
  category: string
  feature: string
  lasagna: Mark
  stancl: Mark
  nestjs: Mark
  advantage?: 'lasagna' | 'stancl'
  lasagnaNote?: string
  stancanNote?: string
  nestjsNote?: string
}

interface Source {
  label: string
  url: string
  accessed: string
}

const rows = data.rows as Row[]
const categories = data.categories as { id: string; label: string }[]

// The three compared packages, in column order. Driving the value cells from
// this list keeps the per-package markup (mark + note + accessible name) in one
// place instead of three copy-pasted blocks.
const PACKAGES = [
  { key: 'lasagna', label: 'Lasagna', note: 'lasagnaNote' },
  { key: 'stancl', label: 'stancl/tenancy', note: 'stancanNote' },
  { key: 'nestjs', label: 'NestJS', note: 'nestjsNote' },
] as const

const nodeLabel = (data as { comparedNode?: string }).comparedNode ?? 'NestJS'
const nestjsSources = ((data as { sources?: { nestjs?: Source[] } }).sources?.nestjs ??
  []) as Source[]

const activeCategory = ref<string>('all')
const onlyAdvantage = ref<'all' | 'lasagna' | 'stancl' | 'parity'>('all')
const search = ref('')

const filtered = computed<Row[]>(() => {
  return rows.filter((r) => {
    if (activeCategory.value !== 'all' && r.category !== activeCategory.value) return false
    if (onlyAdvantage.value === 'lasagna' && r.advantage !== 'lasagna') return false
    if (onlyAdvantage.value === 'stancl' && r.advantage !== 'stancl') return false
    if (onlyAdvantage.value === 'parity' && r.advantage) return false
    if (search.value.trim()) {
      const q = search.value.toLowerCase()
      const hay =
        `${r.feature} ${r.lasagnaNote ?? ''} ${r.stancanNote ?? ''} ${r.nestjsNote ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

// Win / parity counts are deliberately two-way (Lasagna vs stancl): stancl is the
// true peer the page is built around. The NestJS column is Node-ecosystem context
// and does not feed these stats (see the caption under the cards).
const stats = computed(() => {
  const total = rows.length
  const lasagnaWins = rows.filter((r) => r.advantage === 'lasagna').length
  const stancanWins = rows.filter((r) => r.advantage === 'stancl').length
  const parity = total - lasagnaWins - stancanWins
  return { total, lasagnaWins, stancanWins, parity }
})

function categoryLabel(id: string): string {
  return categories.find((c) => c.id === id)?.label ?? id
}

// Accessible name for a value mark, so screen readers announce each otherwise
// icon-only cell (the SVG glyphs carry no text on their own).
function markText(m: Mark): string {
  return m === 'unknown' ? 'unknown, not established by the sources' : m
}

// The glyph for a mark. Keeps the icon choice in one place for all three columns.
function markIcon(m: Mark) {
  if (m === 'yes') return PhCheck
  if (m === 'partial') return PhMinus
  if (m === 'unknown') return PhQuestion
  return PhX
}
</script>

<template>
  <section class="ct-root">
    <header class="ct-header">
      <div class="ct-stats">
        <div class="ct-stat">
          <span class="ct-stat__num">{{ stats.total }}</span>
          <span class="ct-stat__label">features compared</span>
        </div>
        <div class="ct-stat ct-stat--lg">
          <span class="ct-stat__num">{{ stats.lasagnaWins }}</span>
          <span class="ct-stat__label">Lasagna advantage</span>
        </div>
        <div class="ct-stat">
          <span class="ct-stat__num">{{ stats.parity }}</span>
          <span class="ct-stat__label">parity</span>
        </div>
        <div class="ct-stat ct-stat--st">
          <span class="ct-stat__num">{{ stats.stancanWins }}</span>
          <span class="ct-stat__label">stancl advantage</span>
        </div>
      </div>
      <p class="ct-stats-note">
        Win / parity counts compare Lasagna with <code>stancl/tenancy</code>; the
        NestJS column is Node-ecosystem context.
      </p>

      <div class="ct-filters">
        <div class="ct-search">
          <PhMagnifyingGlass :size="16" weight="regular" />
          <input
            v-model="search"
            type="search"
            placeholder="Search a feature…"
            aria-label="Search comparison features"
          />
        </div>

        <div class="ct-segment" role="tablist" aria-label="Filter by advantage">
          <button
            v-for="opt in [
              { id: 'all', label: 'All' },
              { id: 'lasagna', label: 'Lasagna wins' },
              { id: 'parity', label: 'Parity' },
              { id: 'stancl', label: 'stancl wins' },
            ]"
            :key="opt.id"
            type="button"
            role="tab"
            :aria-selected="onlyAdvantage === opt.id"
            :class="['ct-seg-btn', onlyAdvantage === opt.id && 'is-active']"
            @click="onlyAdvantage = opt.id as any"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="ct-cats">
        <button
          type="button"
          :class="['ct-cat', activeCategory === 'all' && 'is-active']"
          @click="activeCategory = 'all'"
        >
          All categories
        </button>
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          :class="['ct-cat', activeCategory === c.id && 'is-active']"
          @click="activeCategory = c.id"
        >
          {{ c.label }}
        </button>
      </div>
    </header>

    <div
      class="ct-table"
      role="table"
      aria-label="Lasagna vs stancl/tenancy vs NestJS feature comparison"
    >
      <div class="ct-row ct-row--head" role="row">
        <div role="columnheader" class="ct-col-feature">Feature</div>
        <div role="columnheader" class="ct-col-package">Lasagna</div>
        <div role="columnheader" class="ct-col-package">stancl/tenancy</div>
        <div role="columnheader" class="ct-col-package">NestJS<sup>*</sup></div>
        <div role="columnheader" class="ct-col-cat">Area</div>
      </div>

      <div
        v-for="(r, i) in filtered"
        :key="r.category + '-' + r.feature + '-' + i"
        :class="['ct-row', r.advantage && `ct-row--win-${r.advantage}`]"
        role="row"
      >
        <div role="cell" class="ct-col-feature">
          <span class="ct-feat-name">
            <PhTrophy
              v-if="r.advantage === 'lasagna'"
              :size="14"
              weight="fill"
              class="ct-trophy ct-trophy--lg"
              aria-label="Lasagna advantage"
            />
            {{ r.feature }}
          </span>
        </div>

        <div
          v-for="p in PACKAGES"
          :key="p.key"
          role="cell"
          class="ct-col-package"
        >
          <span
            :class="['ct-mark', `ct-mark--${r[p.key]}`]"
            role="img"
            :aria-label="`${p.label}: ${markText(r[p.key])}`"
          >
            <component :is="markIcon(r[p.key])" :size="14" weight="bold" />
          </span>
          <span v-if="r[p.note]" class="ct-note">{{ r[p.note] }}</span>
        </div>

        <div role="cell" class="ct-col-cat">{{ categoryLabel(r.category) }}</div>
      </div>

      <div v-if="filtered.length === 0" class="ct-empty">
        No features match the current filters.
      </div>
    </div>

    <footer class="ct-sources">
      <p>
        <sup>*</sup> The <strong>NestJS</strong> column reflects
        {{ nodeLabel }}: the most-used community package
        (<code>nestjs-tenancy</code>, MongoDB) plus common DIY TypeORM/Postgres
        patterns. NestJS ships no first-party multi-tenancy.
        <span class="ct-mark ct-mark--unknown ct-mark--inline" aria-hidden="true"
          ><PhQuestion :size="12" weight="bold"
        /></span>
        marks a capability the sources don't establish either way.
      </p>
      <p v-if="nestjsSources.length">
        Sources:
        <template v-for="(s, i) in nestjsSources" :key="s.url">
          <a :href="s.url" target="_blank" rel="noopener">{{ s.label }}</a>
          <span class="ct-src-date"> (accessed {{ s.accessed }})</span
          ><span v-if="i < nestjsSources.length - 1">; </span>
        </template>
      </p>
    </footer>
  </section>
</template>

<style scoped>
.ct-root { margin: 2rem 0; color: var(--vp-c-text-1); }

.ct-header {
  display: grid;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.ct-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
}
@media (min-width: 700px) { .ct-stats { grid-template-columns: repeat(4, 1fr); } }
.ct-stat {
  background-color: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.ct-stat--lg { border-color: var(--vp-c-brand-1); }
.ct-stat--st { border-color: var(--vp-c-border); }
.ct-stat__num {
  font-size: 1.7rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  line-height: 1;
}
.ct-stat--lg .ct-stat__num { color: var(--vp-c-brand-1); }
.ct-stat--st .ct-stat__num { color: var(--vp-c-text-1); }
.ct-stat__label {
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.ct-stats-note {
  margin: -0.4rem 0 0;
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  line-height: 1.4;
}

.ct-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}
.ct-search {
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 0.4rem 0.85rem;
  background-color: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}
.ct-search input {
  border: 0;
  outline: 0;
  background: transparent;
  flex: 1 1 auto;
  font: inherit;
  color: var(--vp-c-text-1);
}
.ct-search input::placeholder { color: var(--vp-c-text-2); }

.ct-segment {
  display: inline-flex;
  background-color: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
}
.ct-seg-btn {
  background: transparent;
  border: 0;
  color: var(--vp-c-text-2);
  font: inherit;
  font-size: 0.85rem;
  padding: 0.32rem 0.85rem;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 200ms ease, color 200ms ease;
}
.ct-seg-btn.is-active {
  background-color: var(--vp-c-brand-1);
  color: #fff;
}

.ct-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.ct-cat {
  background-color: transparent;
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 180ms ease;
}
.ct-cat:hover { color: var(--vp-c-text-1); border-color: var(--vp-c-border); }
.ct-cat.is-active {
  background-color: var(--vp-c-text-1);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-text-1);
}

.ct-table {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background-color: var(--vp-c-bg-soft);
}
.ct-row {
  display: grid;
  grid-template-columns:
    minmax(190px, 1.8fr) minmax(118px, 1fr) minmax(118px, 1fr)
    minmax(118px, 1fr) minmax(110px, 0.9fr);
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  align-items: start;
  border-top: 1px solid var(--vp-c-divider);
}
.ct-row:first-child { border-top: 0; }
.ct-row--head {
  background-color: var(--vp-c-bg-alt);
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
  padding-top: 0.6rem;
  padding-bottom: 0.6rem;
}
.ct-row--win-lasagna { background-color: var(--vp-c-brand-soft); }
.ct-row--win-stancl  { background-color: var(--vp-c-bg-alt); }

.ct-col-feature { display: flex; flex-direction: column; gap: 0.2rem; }
.ct-feat-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
}
.ct-trophy--lg { color: var(--vp-c-brand-1); }
.ct-col-package {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.ct-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  flex: none;
}
.ct-mark--yes      { background-color: var(--vp-c-brand-1); color: #fff; }
.ct-mark--partial  { background-color: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.ct-mark--no       { background-color: var(--vp-c-bg-alt); color: var(--vp-c-text-2); }
.ct-mark--unknown  {
  background-color: transparent;
  border: 1px dashed var(--vp-c-divider);
  color: var(--vp-c-text-3);
}
.ct-mark--inline { width: 18px; height: 18px; vertical-align: middle; }
.ct-note {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  line-height: 1.35;
}

.ct-col-cat {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ct-empty {
  padding: 2rem;
  text-align: center;
  color: var(--vp-c-text-2);
}

.ct-sources {
  margin-top: 0.9rem;
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}
.ct-sources p { margin: 0.35rem 0; }
.ct-sources a { color: var(--vp-c-brand-1); }
.ct-src-date { color: var(--vp-c-text-3); }

@media (max-width: 800px) {
  .ct-row {
    grid-template-columns: 1fr 1fr 1fr;
    grid-template-areas:
      'feature feature feature'
      'lasagna stancl nestjs'
      'cat     cat    cat';
  }
  .ct-row--head { display: none; }
  .ct-col-feature { grid-area: feature; }
  .ct-col-package:nth-of-type(2) { grid-area: lasagna; }
  .ct-col-package:nth-of-type(3) { grid-area: stancl; }
  .ct-col-package:nth-of-type(4) { grid-area: nestjs; }
  .ct-col-cat { grid-area: cat; }
}
</style>
