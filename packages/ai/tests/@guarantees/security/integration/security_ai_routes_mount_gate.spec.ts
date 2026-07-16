import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { multitenancyAiRoutes } from '../../../../src/routes.js'

/**
 * The G4 mount gate against the REAL booted app and router service. The kit
 * fixture declares no `config.ai`, so both refusal paths are provable without
 * mutating shared config (which the integration baseline guard would flag):
 * an absent middleware chain refuses first, and a present chain still refuses
 * because config.ai is absent. No route is ever mounted, so the router state
 * stays pristine for other groups.
 */
test.group('AI routes mount gate (integration)', () => {
  test('refuses an effectively-absent middleware chain on the booted app', async ({ assert }) => {
    assert.throws(
      () => multitenancyAiRoutes({ middleware: [] }),
      /Refusing to mount AI routes without a middleware chain/
    )
  })

  test('refuses to mount when config.ai is absent, even with middleware', async ({ assert }) => {
    const config = app.config.get('multitenancy') as { ai?: unknown } | undefined
    assert.isUndefined(config?.ai, 'precondition: the fixture declares no ai block')
    assert.throws(
      () => multitenancyAiRoutes({ middleware: 'auth' }),
      /Refusing to mount AI routes: config\.ai is absent/
    )
  })
})
