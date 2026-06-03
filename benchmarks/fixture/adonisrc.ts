import { defineConfig } from '@adonisjs/core/app'

/**
 * Deliberately lean: only the providers the tenancy stack needs. No billing /
 * sso / admin / backup. That isolation of the tenancy stack is the whole reason
 * this is a separate app and not the core test fixture (which loads all the
 * satellites and would add overhead + noise to the HTTP numbers).
 */
export default defineConfig({
  commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@adonisjs/lucid/commands'),
    () => import('@adonisjs-lasagna/saas-tenancy/commands'),
  ],

  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/core/providers/hash_provider'),
    { file: () => import('@adonisjs/core/providers/repl_provider'), environment: ['repl', 'test'] },
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/redis/redis_provider'),
    () => import('@adonisjs/queue/queue_provider'),
    () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
    () => import('./app/providers/bench_provider.js'),
  ],

  preloads: [
    () => import('./start/env.js'),
    () => import('./start/kernel.js'),
    () => import('./start/routes.js'),
  ],

  tests: {
    suites: [],
    forceExit: true,
  },
})
