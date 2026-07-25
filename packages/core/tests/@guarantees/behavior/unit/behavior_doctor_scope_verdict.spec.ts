import { test } from '@japa/runner'
import DoctorService from '../../../../src/services/doctor/doctor_service.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { DoctorCheck, DiagnosisIssue } from '../../../../src/services/doctor/types.js'

function fakeCheck(name: string, issues: DiagnosisIssue[]): DoctorCheck {
  return { name, description: name, run: () => issues }
}

/**
 * The tri-state verdict that lets /admin/health/report answer 200-degraded for one
 * tenant's problem and reserve 503 for genuine platform failure (WS-5).
 */
test.group('DoctorService scope-aware verdict', (group) => {
  group.each.setup(() => setupTestConfig())

  const repo = () => mockTenantRepository([buildTestTenant()])

  test('ok when only warnings/infos are present', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(fakeCheck('w', [{ code: 'x', severity: 'warn', message: 'm' }]))
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'ok')
    assert.equal(result.totals.platformError, 0)
    assert.equal(result.totals.tenantError, 0)
  })

  test('degraded when only tenant-scoped errors are present', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(fakeCheck('t', [{ code: 'e', severity: 'error', message: 'm', tenantId: 'abc' }]))
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'degraded')
    assert.equal(result.totals.tenantError, 1)
    assert.equal(result.totals.platformError, 0)
  })

  test('fail when a platform-scoped error is present', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(
      fakeCheck('p', [{ code: 'e', severity: 'error', message: 'm', scope: 'platform' }])
    )
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'fail')
    assert.equal(result.totals.platformError, 1)
  })

  test('an error with no tenantId infers platform scope (fail)', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(fakeCheck('p', [{ code: 'e', severity: 'error', message: 'm' }]))
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'fail')
    assert.equal(result.totals.platformError, 1)
  })

  test('explicit scope overrides the tenantId inference', async ({ assert }) => {
    const svc = new DoctorService()
    // A tenantId is present, but scope is explicitly platform → platform wins.
    svc.register(
      fakeCheck('p', [
        { code: 'e', severity: 'error', message: 'm', tenantId: 'abc', scope: 'platform' },
      ])
    )
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'fail')
    assert.equal(result.totals.platformError, 1)
  })

  test('fail dominates degraded when both scopes have errors', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(fakeCheck('t', [{ code: 'e1', severity: 'error', message: 'm', tenantId: 'abc' }]))
    svc.register(
      fakeCheck('p', [{ code: 'e2', severity: 'error', message: 'm', scope: 'platform' }])
    )
    const result = await svc.run({}, repo())
    assert.equal(result.status, 'fail')
    assert.equal(result.totals.platformError, 1)
    assert.equal(result.totals.tenantError, 1)
  })
})
