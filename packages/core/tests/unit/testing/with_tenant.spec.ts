import { test } from '@japa/runner'
import { withTenant } from '../../../src/testing/with_tenant.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import { setupTestConfig } from '../../helpers/config.js'
import { buildTestTenant } from '../../../src/testing/builders.js'

test.group('withTenant() — test-time tenant scope', (group) => {
  let registry: BootstrapperRegistry

  group.each.setup(() => {
    setupTestConfig()
    registry = new BootstrapperRegistry()
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry,
    })
  })

  group.each.teardown(() => {
    __configureTenancyForTests({})
  })

  test('activates tenancy.currentId() for the duration of the callback', async ({ assert }) => {
    const tenant = buildTestTenant()
    assert.isUndefined(tenancy.currentId())

    await withTenant(tenant, async () => {
      assert.equal(tenancy.currentId(), tenant.id)
    })

    assert.isUndefined(tenancy.currentId())
  })

  test('returns the callback value', async ({ assert }) => {
    const tenant = buildTestTenant()
    const result = await withTenant(tenant, () => 42)
    assert.equal(result, 42)
  })

  test('runs bootstrapper enter before fn and leave after, even when fn throws', async ({
    assert,
  }) => {
    const tenant = buildTestTenant()
    const calls: string[] = []
    registry.register({
      name: 'probe',
      enter: () => {
        calls.push('enter')
      },
      leave: () => {
        calls.push('leave')
      },
    })

    await assert.rejects(
      () =>
        withTenant(tenant, () => {
          calls.push('fn')
          throw new Error('boom')
        }),
      /boom/
    )
    assert.deepEqual(calls, ['enter', 'fn', 'leave'])
  })
})
