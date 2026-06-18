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
import HomeHero from './components/HomeHero.vue'
import TrustBand from './components/TrustBand.vue'
import HomeArchitecture from './components/HomeArchitecture.vue'
import HomeAdoption from './components/HomeAdoption.vue'
import HomeExtend from './components/HomeExtend.vue'
import HomeCta from './components/HomeCta.vue'

import './style.css'

/**
 * Custom Lasagna theme. We extend the default VitePress layout (so search,
 * sidebar, and dark-mode toggle keep working) and layer a single accent and
 * two typefaces on top through `style.css`.
 *
 * The landing page keeps VitePress's `layout: home` (so the feature cards come
 * from frontmatter), but replaces the plain native hero with a richer custom
 * `HomeHero` (eyebrow, headline, install line, CTAs, and the layered-stack
 * visual) via the `home-hero-before` slot, nulling the native hero slots. The
 * compatibility band, architecture diagram, adoption guide, and the
 * extend-it-yourself band are injected around the feature cards.
 */
const LasagnaLayout = () => {
  const { frontmatter } = useData()

  if (frontmatter.value.layout === 'home') {
    return h(DefaultTheme.Layout, null, {
      'home-hero-before': () => h(HomeHero),
      'home-hero-info': () => null,
      'home-hero-image': () => null,
      'home-features-before': () => h(TrustBand),
      'home-features-after': () => [
        h(HomeArchitecture),
        h(HomeAdoption),
        h(HomeExtend),
        h(HomeCta),
      ],
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
