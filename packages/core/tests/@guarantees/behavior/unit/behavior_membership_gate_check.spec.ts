import { test } from '@japa/runner'
import membershipGateCheck from '../../../../src/services/doctor/checks/membership_gate_check.js'
import { builtInChecks } from '../../../../src/services/doctor/checks/index.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { DoctorContext } from '../../../../src/services/doctor/types.js'

const emptyCtx = { tenants: [], repo: {} as any, attemptFix: false } as DoctorContext

test.group('doctor — membership_gate check', () => {
  test('is registered in builtInChecks', ({ assert }) => {
    assert.isTrue(
      builtInChecks.some((c) => c.name === 'membership_gate'),
      'membership_gate must be a built-in doctor check'
    )
  })

  test('warns when the strategy is client-controlled and no hook is set', async ({ assert }) => {
    // No hook set: omitting authorizeTenantAccess is runtime-equivalent to undefined.
    setupTestConfig({ resolverStrategy: 'header' })
    const issues = await membershipGateCheck.run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'membership_gate_missing')
    assert.equal(issues[0]!.severity, 'warn')
  })

  test('clean when authorizeTenantAccess is wired', async ({ assert }) => {
    setupTestConfig({ resolverStrategy: 'header', authorizeTenantAccess: () => true })
    assert.lengthOf(await membershipGateCheck.run(emptyCtx), 0)
  })

  test('clean when the risk is acknowledged', async ({ assert }) => {
    setupTestConfig({ resolverStrategy: 'header', acknowledgeNoMembershipGate: true })
    assert.lengthOf(await membershipGateCheck.run(emptyCtx), 0)
  })

  test('clean when the strategy is server-controlled (subdomain)', async ({ assert }) => {
    setupTestConfig({ resolverStrategy: 'subdomain' })
    assert.lengthOf(await membershipGateCheck.run(emptyCtx), 0)
  })
})
