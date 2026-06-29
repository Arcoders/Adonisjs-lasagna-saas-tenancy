import { test } from '@japa/runner'
import CircuitBreakerService from '../../../../src/services/circuit_breaker_service.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * Regression guard for the isolation-benchmark 503 storm.
 *
 * WS-2 put the circuit breaker on the request path: the tenant-guard middleware
 * now fires `cbService.run(id)` → `getCircuit(id)` on every guarded request. But
 * `getCircuit()` read `getConfig().circuitBreaker.threshold` WITHOUT a guard, so
 * a config that omits the (normally required) `circuitBreaker` block — an untyped
 * fixture, a config assembled dynamically, a partial block — threw a `TypeError`
 * on every request, which the guard mapped to a 503. The isolation benchmark
 * fixture (untyped, no block) 503'd on 100% of guarded reads.
 *
 * Typed configs (`defineConfig`) can't reach this state, but the runtime must
 * degrade to safe defaults rather than storm 503s. `#evictIfOverCapacity` already
 * defends with `circuitBreaker?.maxTrackedCircuits ?? DEFAULT`; this aligns the
 * hot path.
 *
 * RED (pre-fix): `getCircuit()` throws "Cannot read properties of undefined".
 */
const TENANT = '7b1c0a2e-0000-4000-8000-000000000001'

function configWithoutCircuitBreaker(): MultitenancyConfig {
  const cfg: Record<string, unknown> = { ...testConfig }
  delete cfg.circuitBreaker
  return cfg as unknown as MultitenancyConfig
}

function configWithPartialCircuitBreaker(): MultitenancyConfig {
  // Only `threshold` supplied; the other fields must fall back to defaults.
  return { ...testConfig, circuitBreaker: { threshold: 50 } } as unknown as MultitenancyConfig
}

test.group('CircuitBreakerService — resilient to a missing circuitBreaker config', () => {
  test('getCircuit() falls back to defaults when the block is absent (no throw)', ({ assert }) => {
    setConfig(configWithoutCircuitBreaker())
    const svc = new CircuitBreakerService()
    assert.doesNotThrow(() => svc.getCircuit(TENANT))
    assert.isDefined(svc.getCircuit(TENANT))
  })

  test('a freshly built circuit with no config reports CLOSED', ({ assert }) => {
    setConfig(configWithoutCircuitBreaker())
    const svc = new CircuitBreakerService()
    svc.getCircuit(TENANT)
    assert.isFalse(svc.isOpen(TENANT))
    assert.equal(svc.getMetrics(TENANT)!.state, 'CLOSED')
  })

  test('a partial circuitBreaker block fills the missing fields from defaults', ({ assert }) => {
    setConfig(configWithPartialCircuitBreaker())
    const svc = new CircuitBreakerService()
    assert.doesNotThrow(() => svc.getCircuit(TENANT))
  })
})
