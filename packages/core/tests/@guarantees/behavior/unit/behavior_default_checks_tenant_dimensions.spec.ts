import { test } from '@japa/runner'
import HealthService from '../../../../src/health/health_service.js'
import {
  registerDefaultChecks,
  tenantPoolSaturationThreshold,
} from '../../../../src/health/default_checks.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * WS-2 / readyz-no-tenant-connectivity-dimension.
 *
 * `/readyz` checked the backoffice DB, Redis, and circuit breakers, but nothing
 * about TENANT connectivity (pool saturation, read-replica health) — a pod with
 * exhausted tenant pools or a dead replica still reported ready. The fix adds
 * two OPT-IN, non-critical dimensions.
 *
 * RED (pre-fix): `tenant_pools` / `read_replicas` were never registerable.
 */
test.group('default checks — tenant connectivity dimensions', () => {
  test('the tenant dimensions are OFF by default', ({ assert }) => {
    setupTestConfig()
    const svc = registerDefaultChecks(new HealthService())
    assert.isFalse(svc.hasCheck('tenant_pools'))
    assert.isFalse(svc.hasCheck('read_replicas'))
    // The existing critical defaults are always present (detector control).
    assert.isTrue(svc.hasCheck('backoffice_db'))
    assert.isTrue(svc.hasCheck('redis'))
  })

  test('opting in registers both dimensions as NON-critical', ({ assert }) => {
    setupTestConfig({ health: { tenantPoolsCheck: true, readReplicasCheck: true } })
    const svc = registerDefaultChecks(new HealthService())
    assert.isTrue(svc.hasCheck('tenant_pools'))
    assert.isTrue(svc.hasCheck('read_replicas'))
    // Non-critical: a saturated pool / lagging replica degrades, never 503s.
    assert.isFalse(svc.isCritical('tenant_pools'))
    assert.isFalse(svc.isCritical('read_replicas'))
  })

  test('each dimension is independently gated', ({ assert }) => {
    setupTestConfig({ health: { tenantPoolsCheck: true } })
    const svc = registerDefaultChecks(new HealthService())
    assert.isTrue(svc.hasCheck('tenant_pools'))
    assert.isFalse(svc.hasCheck('read_replicas'))
  })
})

test.group('tenant pool saturation threshold — single sourced', () => {
  test('defaults to the built-in 0.9 when nothing is configured', ({ assert }) => {
    setupTestConfig()
    assert.equal(tenantPoolSaturationThreshold(), 0.9)
  })

  test('falls back to the doctor warn ratio so there is one saturation number', ({ assert }) => {
    setupTestConfig({ doctor: { poolSaturationWarnRatio: 0.75 } })
    assert.equal(tenantPoolSaturationThreshold(), 0.75)
  })

  test('an explicit health threshold overrides the doctor ratio', ({ assert }) => {
    setupTestConfig({
      health: { tenantPoolSaturationThreshold: 0.6 },
      doctor: { poolSaturationWarnRatio: 0.75 },
    })
    assert.equal(tenantPoolSaturationThreshold(), 0.6)
  })
})
