import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { applyFix, applyHeal } from '../../../../src/services/doctor/apply_fix.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { DiagnosisIssue, DoctorContext } from '../../../../src/services/doctor/types.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

/**
 * C5 — the direct apply_fix envelope tests the census flagged as missing. These pin the
 * do-no-harm guards on the NON-heal path (the heal path has its own resilience/chaos
 * coverage): the TOCTOU deleted-refusal, the no-tenantId short-circuit, the fresh
 * re-read (so a condition that changed under the run is seen), and that a throwing fix
 * degrades one issue rather than aborting.
 */
const ctxWith = (repo: any): DoctorContext => ({ tenants: [], repo, attemptFix: true })

const issueFor = (tenantId?: string): DiagnosisIssue => ({
  code: 'provisioning_stalled',
  severity: 'error',
  scope: 'tenant',
  message: 'stalled',
  ...(tenantId !== undefined ? { tenantId } : {}),
  fixable: true,
})

test.group('applyFix — the status-only safe-fix envelope', (group) => {
  group.each.setup(() => setupTestConfig())

  test('an issue with no tenantId is recorded fixed:false and never calls mutate', async ({
    assert,
  }) => {
    const issue = issueFor(undefined)
    let mutated = false
    await applyFix(ctxWith(mockTenantRepository()), issue, async () => {
      mutated = true
    }, { action: 'tenant:doctor:test' })
    assert.isFalse(mutated)
    assert.equal(issue.meta?.fixed, false)
    assert.match(String(issue.meta?.fixError), /no tenantId/)
  })

  test('refuses to mutate a concurrently soft-deleted tenant (TOCTOU guard)', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'active', deletedAt: DateTime.utc() })
    const issue = issueFor(tenant.id)
    let mutated = false
    await applyFix(ctxWith(mockTenantRepository([tenant])), issue, async () => {
      mutated = true
    }, { action: 'tenant:doctor:test' })
    assert.isFalse(mutated, 'a deleted tenant is never mutated')
    assert.equal(issue.meta?.fixed, false)
    assert.match(String(issue.meta?.fixError), /soft-deleted/)
  })

  test('allowDeleted lets a delete-targeting fix touch a soft-deleted tenant', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'active', deletedAt: DateTime.utc() })
    const issue = issueFor(tenant.id)
    let mutated = false
    await applyFix(ctxWith(mockTenantRepository([tenant])), issue, async () => {
      mutated = true
    }, { action: 'tenant:doctor:test', allowDeleted: true })
    assert.isTrue(mutated)
    assert.equal(issue.meta?.fixed, true)
  })

  test('passes the FRESH re-read (not the stale snapshot) to the mutate closure', async ({
    assert,
  }) => {
    // The run's snapshot said "provisioning"; the repo's fresh row is already "active"
    // (it finished under the run). A mutate that re-checks must see the fresh status.
    const stale = buildTestTenant({ id: '11111111-1111-4111-8111-111111111111', status: 'provisioning' })
    const fresh = buildTestTenant({ id: stale.id, status: 'active' })
    const issue = issueFor(stale.id)
    let seenStatus = ''
    await applyFix(ctxWith(mockTenantRepository([fresh])), issue, async (t: TenantModelContract) => {
      seenStatus = t.status
    }, { action: 'tenant:doctor:test' })
    assert.equal(seenStatus, 'active', 'the mutate saw the fresh status, not the stale one')
    assert.equal(issue.meta?.fixed, true)
  })

  test('a throwing fix degrades to fixed:false with the error, never throws', async ({
    assert,
  }) => {
    const tenant = buildTestTenant({ status: 'provisioning' })
    const issue = issueFor(tenant.id)
    await applyFix(ctxWith(mockTenantRepository([tenant])), issue, async () => {
      throw new Error('boom')
    }, { action: 'tenant:doctor:test' })
    assert.equal(issue.meta?.fixed, false)
    assert.match(String(issue.meta?.fixError), /boom/)
  })

  test('the happy path records fixed:true after mutating the fresh row', async ({ assert }) => {
    const tenant = buildTestTenant({ status: 'provisioning' })
    const issue = issueFor(tenant.id)
    await applyFix(ctxWith(mockTenantRepository([tenant])), issue, async (t: TenantModelContract) => {
      t.status = 'failed'
      await t.save()
    }, { action: 'tenant:doctor:test' })
    assert.equal(tenant.status, 'failed')
    assert.equal(issue.meta?.fixed, true)
  })
})

test.group('applyHeal — guard', () => {
  test('an issue with no tenantId is recorded fixed:false without healing', async ({ assert }) => {
    const issue: DiagnosisIssue = { code: 'tenant_failed', severity: 'error', message: 'x', fixable: true }
    await applyHeal(issue)
    assert.equal(issue.meta?.fixed, false)
    assert.match(String(issue.meta?.fixError), /no tenantId/)
  })
})
