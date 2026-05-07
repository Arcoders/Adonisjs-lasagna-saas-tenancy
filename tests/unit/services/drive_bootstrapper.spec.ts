import { test } from '@japa/runner'
import {
  createDriveBootstrapper,
  tenantPrefix,
  TENANT_DRIVE_PREFIX,
} from '../../../src/services/bootstrappers/drive_bootstrapper.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id = 'tenant-1') =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('driveBootstrapper — metadata and prefix helper', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('exposes the canonical name and prefix constant', ({ assert }) => {
    const b = createDriveBootstrapper()
    assert.equal(b.name, 'drive')
    assert.equal(TENANT_DRIVE_PREFIX, 'tenants/')
  })

  test('tenantPrefix() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantPrefix(), /outside a tenancy\.run\(\) scope/)
  })

  test('tenantPrefix() returns tenants/<id>/ inside a scope', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })

    await tenancy.run(fakeTenant('abc123'), async () => {
      assert.equal(tenantPrefix(), 'tenants/abc123/')
    })
  })
})

test.group('driveBootstrapper — enter rejects unsafe ids', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('throws when tenant id contains path-traversal chars', async ({ assert }) => {
    const b = createDriveBootstrapper()
    assert.throws(
      () => b.enter({ tenant: { id: '../etc/passwd' } as any }),
      /Refusing to use unsafe/
    )
  })

  test('throws on shell metacharacters that could escape a path component', ({
    assert,
  }) => {
    const b = createDriveBootstrapper()
    assert.throws(
      () => b.enter({ tenant: { id: 'a/b' } as any }),
      /Refusing to use unsafe/
    )
    assert.throws(
      () => b.enter({ tenant: { id: 'a;b' } as any }),
      /Refusing to use unsafe/
    )
  })

  test('accepts UUID v4 tenant ids', ({ assert }) => {
    const b = createDriveBootstrapper()
    assert.doesNotThrow(() =>
      b.enter({ tenant: { id: '11111111-1111-4111-8111-111111111111' } as any })
    )
  })
})

test.group('driveBootstrapper — tenancy.run rejects traversal payloads end-to-end', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  const PAYLOADS = [
    '../',
    '..\\',
    '../../etc/passwd',
    '%2e%2e/',
    'tenant_a/../tenant_b',
    'a/b',
    'a\\b',
    'a;b',
    'a"b',
    'a b',
    '',
    'a'.repeat(64),
  ]

  for (const payload of PAYLOADS) {
    test(`tenancy.run rejects tenant.id "${payload}" via the drive bootstrapper`, async ({
      assert,
    }) => {
      const logCtx = new TenantLogContext()
      const registry = new BootstrapperRegistry()
      registry.register(createDriveBootstrapper())
      __configureTenancyForTests({ logCtx, registry })

      await assert.rejects(
        () => tenancy.run(fakeTenant(payload), async () => 'reached'),
        /Refusing to use unsafe/
      )
    })
  }

  test('tenantPrefix() inside a UUID-v4 scope returns the safe prefix', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    registry.register(createDriveBootstrapper())
    __configureTenancyForTests({ logCtx, registry })

    const id = '11111111-1111-4111-8111-111111111111'
    await tenancy.run(fakeTenant(id), async () => {
      assert.equal(tenantPrefix(), `tenants/${id}/`)
    })
  })
})
