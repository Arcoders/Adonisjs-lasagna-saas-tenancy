import { test } from '@japa/runner'
import {
  createTransmitBootstrapper,
  tenantChannel,
  TENANT_BROADCAST_PREFIX,
} from '../../../src/services/bootstrappers/transmit_bootstrapper.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id = 'tenant-1') =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('transmitBootstrapper — metadata and channel helper', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('exposes the canonical name and prefix constant', ({ assert }) => {
    const b = createTransmitBootstrapper()
    assert.equal(b.name, 'transmit')
    assert.equal(TENANT_BROADCAST_PREFIX, 'tenants/')
  })

  test('tenantChannel() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantChannel('chat'), /outside a tenancy\.run\(\) scope/)
  })

  test('tenantChannel() returns tenants/<id>/<channel> inside a scope', async ({
    assert,
  }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })

    await tenancy.run(fakeTenant('abc123'), async () => {
      assert.equal(tenantChannel('chat'), 'tenants/abc123/chat')
      assert.equal(tenantChannel('/notifications'), 'tenants/abc123/notifications')
    })
  })

  test('honors a custom prefix passed to createTransmitBootstrapper', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })
    createTransmitBootstrapper({ prefix: 'orgs/' })

    await tenancy.run(fakeTenant('xyz'), async () => {
      assert.equal(tenantChannel('chat'), 'orgs/xyz/chat')
    })
    // Restore default for other tests in the file
    createTransmitBootstrapper()
  })
})

test.group('transmitBootstrapper — enter rejects unsafe ids', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('throws when tenant id contains path-traversal chars', ({ assert }) => {
    const b = createTransmitBootstrapper()
    assert.throws(
      () => b.enter({ tenant: { id: '../etc/passwd' } as any }),
      /Refusing to use unsafe/
    )
  })

  test('throws on slashes that could escape a channel name', ({ assert }) => {
    const b = createTransmitBootstrapper()
    assert.throws(
      () => b.enter({ tenant: { id: 'a/b' } as any }),
      /Refusing to use unsafe/
    )
  })
})
