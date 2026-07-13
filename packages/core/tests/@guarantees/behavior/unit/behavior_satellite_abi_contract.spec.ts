import { test } from '@japa/runner'
import HookRegistry from '../../../../src/services/hook_registry.js'
import DoctorService from '../../../../src/services/doctor/doctor_service.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import { ResolverHit } from '../../../../src/services/resolvers/resolver.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'
import type { IsolationDriver } from '../../../../src/services/isolation/driver.js'
import * as sdk from '../../../../src/sdk/index.js'

/**
 * Satellite ABI contract test (B5).
 *
 * These are the surfaces a packaged satellite self-registers into
 * ([sdk/contract.ts]). They are the public extension contract third-party
 * satellites build against, versioned by `SATELLITE_API_VERSION`. This spec
 * pins their method shapes + core behaviour so a signature/semantic change is
 * caught here (and forces a deliberate `SATELLITE_API_VERSION` bump) instead of
 * silently breaking every installed satellite at runtime.
 *
 * If you change anything asserted below, you are changing the Satellite ABI:
 * bump `SATELLITE_API_VERSION` and document the migration.
 */

function fakeTenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

test.group('Satellite ABI — HookRegistry', () => {
  test('exposes before/after/loadDeclarative/run/clear', ({ assert }) => {
    const h = new HookRegistry()
    for (const m of ['before', 'after', 'loadDeclarative', 'run', 'clear'] as const) {
      assert.isFunction((h as any)[m], `HookRegistry.${m}`)
    }
  })

  test('before(event, hook) runs with a { tenant } context', async ({ assert }) => {
    const h = new HookRegistry()
    let seen: string | undefined
    h.before('destroy', (ctx) => {
      seen = ctx.tenant.id
    })
    await h.run('before', 'destroy', { tenant: fakeTenant('t-1') })
    assert.equal(seen, 't-1')
  })
})

test.group('Satellite ABI — DoctorService', () => {
  test('register/unregister/has/list manage named checks', ({ assert }) => {
    const d = new DoctorService()
    for (const m of ['register', 'unregister', 'has', 'list'] as const) {
      assert.isFunction((d as any)[m], `DoctorService.${m}`)
    }
    const check = { name: 'demo', description: 'd', run: async () => [] }
    d.register(check)
    assert.isTrue(d.has('demo'))
    assert.deepEqual(
      d.list().map((c) => c.name),
      ['demo']
    )
    d.unregister('demo')
    assert.isFalse(d.has('demo'))
  })
})

test.group('Satellite ABI — IsolationDriverRegistry', () => {
  test('register/use/active/get/has/list/clear route to a driver by name', ({ assert }) => {
    const r = new IsolationDriverRegistry()
    for (const m of ['register', 'use', 'active', 'get', 'has', 'list', 'clear'] as const) {
      assert.isFunction((r as any)[m], `IsolationDriverRegistry.${m}`)
    }
    const driver = {
      name: 'fake-driver',
      contractVersion: 2,
      tableLocation: () => ({ kind: 'connection', connectionName: 'fake' }),
    } as unknown as IsolationDriver
    r.register(driver, { activate: true })
    assert.equal(r.active().name, 'fake-driver')
    assert.isTrue(r.has('fake-driver'))
    assert.include(r.list(), 'fake-driver')
    assert.throws(() => r.use('nope'), /not registered/)
  })
})

test.group('Satellite ABI — TenantResolverRegistry', () => {
  test('register/setChain/resolve/resolveSync/chain/has/list/unregister/clear', async ({
    assert,
  }) => {
    const r = new TenantResolverRegistry()
    for (const m of [
      'register',
      'unregister',
      'has',
      'list',
      'setChain',
      'chain',
      'resolve',
      'resolveSync',
      'clear',
    ] as const) {
      assert.isFunction((r as any)[m], `TenantResolverRegistry.${m}`)
    }
    r.register({
      name: 'fixed',
      contractVersion: 2,
      resolve: () => ResolverHit.id('t-9'),
      resolveSync: () => ResolverHit.id('t-9'),
    })
    r.setChain(['fixed'])
    assert.deepEqual(await r.resolve({} as any), { type: 'id', tenantId: 't-9' })
    assert.deepEqual(r.resolveSync({} as any), { type: 'id', tenantId: 't-9' })
    assert.throws(() => r.setChain(['unknown']), /unknown resolver/)
  })
})

test.group('Satellite ABI — /sdk public surface', () => {
  test('exposes the versioned ABI + manifest + configure toolkit', ({ assert }) => {
    assert.isTrue(Number.isInteger(sdk.SATELLITE_API_VERSION))
    for (const fn of [
      'checkSatelliteApiCompat',
      'readSatelliteManifest',
      'isSafeRelativePath',
      'discoverSatellites',
      'indexSatellites',
      'publishSatellite',
      'registerSatelliteInRcFile',
      'printSatelliteManifest',
      'filterAlreadyPublished',
      'listExistingMigrations',
      'migrationSlug',
      'resolveSatelliteDependencies',
      'satisfiesRange',
      'isUuidV4',
      'assertSafeIdentifier',
    ] as const) {
      assert.isFunction((sdk as any)[fn], `/sdk export ${fn}`)
    }
  })
})
