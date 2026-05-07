import type { Theme } from 'vitepress'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'

import LasagnaCard from './components/LasagnaCard.vue'
import Callout from './components/Callout.vue'
import CodeLayer from './components/CodeLayer.vue'
import ZelligeStar from './components/ZelligeStar.vue'
import HomeLayered from './components/HomeLayered.vue'
import LayeredHero from './components/LayeredHero.vue'
import ComparisonTable from './components/ComparisonTable.vue'
import LayerStack from './components/LayerStack.vue'
import Terminal from './components/Terminal.vue'
import WebhookStateMachine from './components/WebhookStateMachine.vue'
import PageFeedback from './components/PageFeedback.vue'

import './style.css'

/**
 * Custom Lasagna theme. We extend the default VitePress layout (so search,
 * sidebar, and dark-mode toggle keep working) and drop the Zellige surface
 * treatments through `style.css` and the components below.
 *
 * Pages can opt into the marketing landing layout by setting frontmatter:
 *
 *   ---
 *   layout: home
 *   lasagnaHome: true
 *   ---
 *
 * That keeps VitePress's nav + footer chrome but replaces the body with
 * the bespoke `<HomeLayered>` component via the `home-hero-before` slot
 * (and emptying every other default-home slot).
 */
const LasagnaLayout = () => {
  const { frontmatter } = useData()
  if (frontmatter.value.lasagnaHome) {
    return h(DefaultTheme.Layout, null, {
      'home-hero-before': () => h(HomeLayered),
      'home-hero-info-before': () => null,
      'home-hero-info': () => null,
      'home-hero-info-after': () => null,
      'home-hero-actions-after': () => null,
      'home-hero-image': () => null,
      'home-hero-after': () => null,
      'home-features-before': () => null,
      'home-features-after': () => null,
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
    app.component('CodeLayer', CodeLayer)
    app.component('ZelligeStar', ZelligeStar)
    app.component('LayeredHero', LayeredHero)
    app.component('HomeLayered', HomeLayered)
    app.component('ComparisonTable', ComparisonTable)
    app.component('LayerStack', LayerStack)
    app.component('Terminal', Terminal)
    app.component('WebhookStateMachine', WebhookStateMachine)
  },
} satisfies Theme
