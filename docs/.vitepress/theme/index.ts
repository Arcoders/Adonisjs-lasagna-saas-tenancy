import type { Theme } from 'vitepress'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'

import LasagnaCard from './components/LasagnaCard.vue'
import Callout from './components/Callout.vue'
import ComparisonTable from './components/ComparisonTable.vue'
import Terminal from './components/Terminal.vue'
import PageFeedback from './components/PageFeedback.vue'

// Landing-page sections, injected into VitePress's native home slots (below).
// They are not referenced from markdown, so they need no global registration.
import CopyCommand from './components/CopyCommand.vue'
import TrustBand from './components/TrustBand.vue'
import HomeArchitecture from './components/HomeArchitecture.vue'
import HomeAdoption from './components/HomeAdoption.vue'

import './style.css'

/**
 * Custom Lasagna theme. We extend the default VitePress layout (so search,
 * sidebar, and dark-mode toggle keep working) and layer a single accent and
 * two typefaces on top through `style.css`.
 *
 * The landing page uses VitePress's native `layout: home` (hero + features
 * from frontmatter). We enrich it by injecting four section components into
 * the home slots: a copy-paste install line and a compatibility band under
 * the hero, then an architecture diagram and an adoption guide under the
 * feature cards.
 */
const LasagnaLayout = () => {
  const { frontmatter } = useData()

  if (frontmatter.value.layout === 'home') {
    return h(DefaultTheme.Layout, null, {
      'home-hero-after': () => [h(CopyCommand), h(TrustBand)],
      'home-features-after': () => [h(HomeArchitecture), h(HomeAdoption)],
    })
  }

  // Mount the feedback widget on every non-home page via the doc-after slot.
  return h(DefaultTheme.Layout, null, {
    'doc-after': () => h(PageFeedback),
  })
}

export default {
  extends: DefaultTheme,
  Layout: LasagnaLayout,
  enhanceApp({ app }) {
    app.component('LasagnaCard', LasagnaCard)
    app.component('Callout', Callout)
    app.component('ComparisonTable', ComparisonTable)
    app.component('Terminal', Terminal)
  },
} satisfies Theme
