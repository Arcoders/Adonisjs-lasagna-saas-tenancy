import { defineConfig } from '@adonisjs/inertia'
import type { InferSharedProps } from '@adonisjs/inertia/types'
import type InertiaMiddleware from '#app/middleware/inertia_middleware'

/**
 * Inertia server config. The React SPA is served through the `inertia_layout`
 * Edge shell (resources/views/inertia_layout.edge); SSR stays off — these are
 * authenticated back-office consoles, not SEO surfaces, so a client-rendered
 * SPA keeps the runtime (and the deploy) simpler.
 *
 * Per-request shared props (flash, validation errors, the signed-in user) are
 * produced by app/middleware/inertia_middleware.ts, not here — v4 moved sharing
 * onto the middleware's `share()` method.
 */
const inertiaConfig = defineConfig({
  rootView: 'inertia_layout',
  ssr: { enabled: false },
})

export default inertiaConfig

declare module '@adonisjs/inertia/types' {
  export interface SharedProps extends InferSharedProps<InertiaMiddleware> {}

  // Page props are validated on the React side (inertia/pages/**). A permissive
  // index keeps `inertia.render('operator/dashboard', props)` callable for any
  // page without a per-page server-side prop declaration.
  export interface InertiaPages {
    [page: string]: Record<string, any>
  }
}
