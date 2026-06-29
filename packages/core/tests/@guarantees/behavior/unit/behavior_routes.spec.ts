import { test } from '@japa/runner'
import { assertMetricsGuarded } from '../../../../src/health/assert_metrics_guarded.js'

/**
 * P0-2: `/metrics` must fail closed. The Prometheus output carries per-tenant
 * labels (circuit-breaker state, queue depths) and tenant counts by status, so
 * a public `/metrics` leaks tenant enumeration and business KPIs. Like
 * `multitenancyAdminRoutes`, the helper refuses to mount it without an explicit
 * guard, or an explicit `false` opt-out.
 *
 * The rule is extracted into a router-free module (`assertMetricsGuarded`) so it
 * can be asserted without importing `routes.ts`, which eagerly pulls in the
 * `@adonisjs/core/services/router` service (it `await app.booted(...)`s at
 * module load and throws outside an Ignitor). `multitenancyRoutes` calls this
 * guard before any route is registered.
 */
test.group('multitenancyRoutes — /metrics fail-closed', () => {
  const fakeMiddleware = () => {}

  test('throws when metrics is enabled and no metricsMiddleware is passed', ({ assert }) => {
    assert.throws(() => assertMetricsGuarded(true, undefined), /metricsMiddleware. is required/)
  })

  test('treats null like omitted (not like the false opt-out) and throws', ({ assert }) => {
    assert.throws(() => assertMetricsGuarded(true, null), /metricsMiddleware. is required/)
  })

  test('treats an EMPTY ARRAY as absent and throws (no silent public mount)', ({ assert }) => {
    // The dangerous case: `authEnabled ? [auth] : []` must not mount /metrics
    // public when the list comes out empty.
    assert.throws(() => assertMetricsGuarded(true, []), /metricsMiddleware. is required/)
  })

  test('treats an empty string as absent and throws', ({ assert }) => {
    assert.throws(() => assertMetricsGuarded(true, ''), /metricsMiddleware. is required/)
  })

  test('does not throw when an explicit false opt-out is passed (public on purpose)', ({
    assert,
  }) => {
    assert.doesNotThrow(() => assertMetricsGuarded(true, false))
  })

  test('does not throw when real middleware is passed', ({ assert }) => {
    assert.doesNotThrow(() => assertMetricsGuarded(true, fakeMiddleware))
    assert.doesNotThrow(() => assertMetricsGuarded(true, [fakeMiddleware]))
    assert.doesNotThrow(() => assertMetricsGuarded(true, 'auth'))
  })

  test('does not throw for the missing-middleware reason when metrics is disabled', ({
    assert,
  }) => {
    assert.doesNotThrow(() => assertMetricsGuarded(false, undefined))
  })

  test('error message points operators at the three valid choices', ({ assert }) => {
    let message = ''
    try {
      assertMetricsGuarded(true, undefined)
    } catch (err) {
      message = (err as Error).message
    }
    assert.include(message, 'metricsMiddleware: false') // explicit public opt-out
    assert.include(message, 'metrics: false') // do not mount at all
    assert.include(message, 'refuses to mount without a guard')
  })
})
