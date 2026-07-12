import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { isProductionNodeEnv } from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * PLD-8 parity pin.
 *
 * `isProductionNodeEnv()` is a pure NODE_ENV read (no app import) so resolver and
 * config modules stay importable from a bare unit runner. That independence is
 * only safe while its notion of "production" cannot diverge from the framework's:
 * a security gate that read `=== 'production'` would silently stay open on a
 * `NODE_ENV=prod` deployment that AdonisJS itself treats as production.
 *
 * This runs in the integration harness because `app.inProduction` is only
 * meaningful once the app has initialized (AdonisJS normalizes NODE_ENV during
 * `init()`). It pins that, in the actual runtime environment, the helper and the
 * framework agree. The normalization parity itself (`prod`/`production`) is
 * documented on the helper in `utils/env.ts`.
 */
test.group('isProductionNodeEnv parity', () => {
  test('isProductionNodeEnv() agrees with the framework app.inProduction', ({ assert }) => {
    assert.equal(isProductionNodeEnv(), app.inProduction)
  })
})
