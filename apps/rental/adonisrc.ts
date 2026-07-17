import { defineConfig } from '@adonisjs/core/app'

/**
 * Karimoto — the car-rental SaaS reference application.
 *
 * Providers are added in the same order the platform expects: framework
 * providers first, then the multitenancy kernel, then the satellites (wired in
 * later phases), then this app's own provider last so its boot() can see every
 * registry the satellites bound.
 */
export default defineConfig({
  commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@adonisjs/lucid/commands'),
    () => import('@adonisjs/queue/commands'),
    () => import('@adonisjs-lasagna/saas-tenancy/commands'),
    () => import('@adonisjs-lasagna/backup/commands'),
    () => import('@adonisjs-lasagna/billing/commands'),
    () => import('@adonisjs-lasagna/reporting/commands'),
    () => import('@adonisjs-lasagna/ai/commands'),
    () => import('@adonisjs-lasagna/crypto/commands'),
  ],

  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/core/providers/hash_provider'),
    {
      file: () => import('@adonisjs/core/providers/repl_provider'),
      environment: ['repl', 'test'],
    },
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/redis/redis_provider'),
    () => import('@adonisjs/queue/queue_provider'),
    () => import('@adonisjs/mail/mail_provider'),
    () => import('@adonisjs/core/providers/vinejs_provider'),
    () => import('@adonisjs/auth/auth_provider'),
    // Browser-console stack: sessions back the `web-*` guards, Vite serves the
    // React bundle, Edge renders the Inertia shell, and Inertia bridges the two.
    // Vite must register before Inertia (the Inertia manager resolves `vite` from
    // the container), and Edge before Inertia renders the root view via ctx.view.
    () => import('@adonisjs/session/session_provider'),
    () => import('@adonisjs/vite/vite_provider'),
    () => import('@adonisjs/core/providers/edge_provider'),
    () => import('@adonisjs/inertia/inertia_provider'),
    () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
    () => import('@adonisjs-lasagna/backup/provider'),
    () => import('@adonisjs-lasagna/billing/provider'),
    () => import('@adonisjs-lasagna/websockets/provider'),
    () => import('@adonisjs-lasagna/reporting/provider'),
    () => import('@adonisjs-lasagna/ai/provider'),
    () => import('@adonisjs-lasagna/crypto/provider'),
    () => import('#app/plugins/telematics_plugin'),
    () => import('#app/providers/app_provider'),
  ],

  preloads: [
    () => import('#start/env'),
    () => import('#start/kernel'),
    () => import('#start/routes'),
    () => import('#start/socket'),
  ],

  // Copied verbatim into ./build on `node ace build` so the compiled server can
  // still render the Edge shell and serve the compiled Vite assets. The Vite dev
  // server is auto-detected from vite.config.ts and started by `node ace serve`.
  metaFiles: [
    { pattern: 'resources/views/**/*.edge', reloadServer: false },
    { pattern: 'public/**', reloadServer: false },
  ],

  tests: {
    suites: [
      {
        name: 'e2e',
        files: ['tests/@integration/e2e/**/*.spec.ts'],
        timeout: 30_000,
      },
    ],
    forceExit: true,
  },
})
