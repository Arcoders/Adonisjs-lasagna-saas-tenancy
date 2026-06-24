import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@adonisjs/lucid/commands'),
    () => import('@adonisjs/queue/commands'),
    () => import('@adonisjs-lasagna/saas-tenancy/commands'),
    () => import('@adonisjs-lasagna/backup/commands'),
    () => import('@adonisjs-lasagna/billing/commands'),
    () => import('@adonisjs-lasagna/reporting/commands'),
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
    () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
    () => import('@adonisjs-lasagna/backup/provider'),
    () => import('@adonisjs-lasagna/billing/provider'),
    () => import('@adonisjs-lasagna/websockets/provider'),
    () => import('@adonisjs-lasagna/reporting/provider'),
    () => import('#app/providers/app_provider'),
  ],

  preloads: [
    () => import('#start/env'),
    () => import('#start/kernel'),
    () => import('#start/routes'),
    () => import('#start/socket'),
  ],

  tests: {
    suites: [
      {
        name: 'e2e',
        files: ['tests/e2e/**/*.spec.ts'],
        timeout: 30_000,
      },
    ],
    forceExit: true,
  },
})
