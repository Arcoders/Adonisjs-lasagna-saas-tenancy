import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  // Mirrors what `node ace configure @adonisjs-lasagna/saas-tenancy` writes into a host's adonisrc.
  // Without this, `ace.exec('tenant:billing:replay', …)` and other tenant commands resolve to
  // `CommandNotFound` because the manifest is never loaded.
  commands: [() => import('@adonisjs-lasagna/saas-tenancy/commands')],

  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/core/providers/hash_provider'),
    { file: () => import('@adonisjs/core/providers/repl_provider'), environment: ['test'] },
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/redis/redis_provider'),
    () => import('@adonisjs/queue/queue_provider'),
    () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
    () => import('./app/providers/fixture_provider.js'),
  ],

  preloads: [
    () => import('./start/env.js'),
    () => import('./start/routes.js'),
    () => import('./start/kernel.js'),
  ],

  tests: {
    suites: [
      {
        name: 'integration',
        files: ['../../tests/integration/**/*.spec.ts'],
        timeout: 30000,
      },
    ],
    forceExit: true,
  },
})
