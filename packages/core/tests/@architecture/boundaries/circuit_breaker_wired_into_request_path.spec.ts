import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-2 / circuit-breaker-never-auto-trips (anti-regression lock).
 *
 * The breaker only opens if a request-path call FIRES it. Before the fix the
 * guard merely read `isOpen()`, so the breaker was inert. This pins the wiring:
 * both the tenant guard and the universal middleware must drive the breaker via
 * `CircuitBreakerService.run(...)`, not just read its state.
 *
 * RED (pre-fix): neither middleware references `.run(` on the breaker.
 */
const GUARD = fileURLToPath(
  new URL('../../../src/middleware/tenant_guard_middleware.ts', import.meta.url)
)
const UNIVERSAL = fileURLToPath(
  new URL('../../../src/middleware/universal_middleware.ts', import.meta.url)
)

test.group('architectural — circuit breaker is fired on the request path', () => {
  test('the tenant guard fires the breaker (run), not only reads isOpen', ({ assert }) => {
    const src = readFileSync(GUARD, 'utf8')
    assert.match(src, /cbService\.run\(/, 'guard must fire CircuitBreakerService.run(...)')
  })

  test('the universal middleware also fires the breaker', ({ assert }) => {
    const src = readFileSync(UNIVERSAL, 'utf8')
    assert.match(
      src,
      /cbService\.run\(/,
      'universal middleware must fire CircuitBreakerService.run(...)'
    )
  })

  test('detector controls: the matcher is not vacuously true', ({ assert }) => {
    assert.match('await cbService.run(tenant.id)', /cbService\.run\(/)
    assert.notMatch('if (cbService.isOpen(tenant.id)) {}', /cbService\.run\(/)
  })
})
