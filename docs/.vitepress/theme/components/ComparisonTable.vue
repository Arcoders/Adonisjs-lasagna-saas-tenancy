<script setup lang="ts">
import { computed, ref } from 'vue'
import { PhCheck, PhX, PhMinus, PhTrophy, PhMagnifyingGlass } from '@phosphor-icons/vue'
import data from '../../../data/comparison.json'

interface Row {
  category: string
  feature: string
  lasagna: 'yes' | 'partial' | 'no'
  stancl: 'yes' | 'partial' | 'no'
  advantage?: 'lasagna' | 'stancl'
  lasagnaNote?: string
  stancanNote?: string
}

const rows = data.rows as Row[]
const categories = data.categories as { id: string; label: string }[]

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
      const hay = `${r.feature} ${r.lasagnaNote ?? ''} ${r.stancanNote ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

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

    <div class="ct-table" role="table" aria-label="Lasagna vs stancl/tenancy feature comparison">
      <div class="ct-row ct-row--head" role="row">
        <div role="columnheader" class="ct-col-feature">Feature</div>
        <div role="columnheader" class="ct-col-package">Lasagna</div>
        <div role="columnheader" class="ct-col-package">stancl/tenancy</div>
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

        <div role="cell" class="ct-col-package">
          <span :class="['ct-mark', `ct-mark--${r.lasagna}`]">
            <PhCheck v-if="r.lasagna === 'yes'" :size="14" weight="bold" />
            <PhMinus v-else-if="r.lasagna === 'partial'" :size="14" weight="bold" />
            <PhX v-else :size="14" weight="bold" />
          </span>
          <span v-if="r.lasagnaNote" class="ct-note">{{ r.lasagnaNote }}</span>
        </div>

        <div role="cell" class="ct-col-package">
          <span :class="['ct-mark', `ct-mark--${r.stancl}`]">
            <PhCheck v-if="r.stancl === 'yes'" :size="14" weight="bold" />
            <PhMinus v-else-if="r.stancl === 'partial'" :size="14" weight="bold" />
            <PhX v-else :size="14" weight="bold" />
          </span>
          <span v-if="r.stancanNote" class="ct-note">{{ r.stancanNote }}</span>
        </div>

        <div role="cell" class="ct-col-cat">{{ categoryLabel(r.category) }}</div>
      </div>

      <div v-if="filtered.length === 0" class="ct-empty">
        No features match the current filters.
      </div>
    </div>
  </section>
</template>

<style scoped>
.ct-root { margin: 2rem 0; color: var(--lg-text); }

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
  background-color: var(--lg-surface);
  border: 1px solid var(--lg-line);
  border-radius: 12px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.ct-stat--lg { border-color: var(--lg-accent); }
.ct-stat--st { border-color: var(--lg-accent-2); }
.ct-stat__num {
  font-family: var(--lg-font-serif);
  font-size: 1.7rem;
  font-weight: 600;
  color: var(--lg-text);
  line-height: 1;
}
.ct-stat--lg .ct-stat__num { color: var(--lg-accent); }
.ct-stat--st .ct-stat__num { color: var(--lg-accent-2); }
.ct-stat__label {
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--lg-text-muted);
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
  border: 1px solid var(--lg-line);
  border-radius: 999px;
  padding: 0.4rem 0.85rem;
  background-color: var(--lg-surface);
  color: var(--lg-text-muted);
}
.ct-search input {
  border: 0;
  outline: 0;
  background: transparent;
  flex: 1 1 auto;
  font: inherit;
  color: var(--lg-text);
}
.ct-search input::placeholder { color: var(--lg-text-muted); }

.ct-segment {
  display: inline-flex;
  background-color: var(--lg-surface);
  border: 1px solid var(--lg-line);
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
}
.ct-seg-btn {
  background: transparent;
  border: 0;
  color: var(--lg-text-muted);
  font: inherit;
  font-size: 0.85rem;
  padding: 0.32rem 0.85rem;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 200ms ease, color 200ms ease;
}
.ct-seg-btn.is-active {
  background-color: var(--lg-accent);
  color: var(--lg-bg);
}

.ct-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.ct-cat {
  background-color: transparent;
  color: var(--lg-text-muted);
  border: 1px solid var(--lg-line);
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 180ms ease;
  font-family: var(--lg-font-sans);
}
.ct-cat:hover { color: var(--lg-text); border-color: var(--lg-line-strong); }
.ct-cat.is-active {
  background-color: var(--lg-accent-2);
  color: var(--lg-bg);
  border-color: var(--lg-accent-2);
}

.ct-table {
  border: 1px solid var(--lg-line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--lg-shadow-card);
  background-color: var(--lg-surface);
}
.ct-row {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) minmax(140px, 1.2fr) minmax(140px, 1.2fr) minmax(120px, 1fr);
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  align-items: start;
  border-top: 1px solid var(--lg-line);
}
.ct-row:first-child { border-top: 0; }
.ct-row--head {
  background-color: rgba(194, 106, 75, 0.06);
  font-family: var(--lg-font-mono);
  font-size: 0.74rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lg-text-muted);
  padding-top: 0.6rem;
  padding-bottom: 0.6rem;
}
.ct-row--win-lasagna { background-color: rgba(194, 106, 75, 0.04); }
.ct-row--win-stancl  { background-color: rgba(42, 107, 124, 0.04); }

.ct-col-feature { display: flex; flex-direction: column; gap: 0.2rem; }
.ct-feat-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 500;
  color: var(--lg-text);
}
.ct-trophy--lg { color: var(--lg-accent); }
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
.ct-mark--yes      { background-color: var(--lg-accent); color: var(--lg-bg); }
.ct-mark--partial  { background-color: var(--lg-accent-2-soft); color: var(--lg-bg); }
.ct-mark--no       { background-color: rgba(46, 42, 38, 0.12); color: var(--lg-text-muted); }
.ct-note {
  font-size: 0.82rem;
  color: var(--lg-text-muted);
  line-height: 1.35;
}

.ct-col-cat {
  font-size: 0.82rem;
  color: var(--lg-text-muted);
  font-family: var(--lg-font-mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ct-empty {
  padding: 2rem;
  text-align: center;
  color: var(--lg-text-muted);
}

@media (max-width: 800px) {
  .ct-row {
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'feature feature'
      'lasagna stancl'
      'cat     cat';
  }
  .ct-row--head { display: none; }
  .ct-col-feature { grid-area: feature; }
  .ct-col-package:nth-of-type(2) { grid-area: lasagna; }
  .ct-col-package:nth-of-type(3) { grid-area: stancl; }
  .ct-col-cat { grid-area: cat; }
}
</style>
