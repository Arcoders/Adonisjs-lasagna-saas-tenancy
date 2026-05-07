import { test } from '@japa/runner'
import { buildTestTenant } from '../../../src/testing/builders.js'
import { mockTenantRepository } from '../../../src/testing/mock_repository.js'
import { setupTestConfig } from '../../helpers/config.js'

interface AcmeMetadata {
  plan: 'free' | 'pro' | 'enterprise'
  trialEndsAt: string | null
  features: string[]
}

test.group('TMeta generic — buildTestTenant', (group) => {
  group.each.setup(() => setupTestConfig())

  test('accepts a typed metadata object via generic', ({ assert }) => {
    const tenant = buildTestTenant<AcmeMetadata>({
      metadata: {
        plan: 'pro',
        trialEndsAt: '2026-12-31',
        features: ['feature_a', 'feature_b'],
      },
    })

    // Compile-time: tenant.metadata is typed as AcmeMetadata | undefined.
    assert.equal(tenant.metadata?.plan, 'pro')
    assert.deepEqual(tenant.metadata?.features, ['feature_a', 'feature_b'])
    assert.equal(tenant.metadata?.trialEndsAt, '2026-12-31')
  })

  test('metadata is undefined when not provided', ({ assert }) => {
    const tenant = buildTestTenant<AcmeMetadata>()
    assert.isUndefined(tenant.metadata)
  })

  test('without generic, metadata is the default record type and accepts any keys', ({ assert }) => {
    const tenant = buildTestTenant({ metadata: { whatever: 1, foo: 'bar' } })
    assert.equal(tenant.metadata?.whatever, 1)
    assert.equal(tenant.metadata?.foo, 'bar')
  })
})

test.group('TMeta generic — MockTenantRepository', (group) => {
  group.each.setup(() => setupTestConfig())

  test('repo carries the generic through findById', async ({ assert }) => {
    const repo = mockTenantRepository<AcmeMetadata>()
    const tenant = buildTestTenant<AcmeMetadata>({
      metadata: { plan: 'enterprise', trialEndsAt: null, features: [] },
    })
    repo.add(tenant)

    const found = await repo.findById(tenant.id)
    assert.equal(found?.metadata?.plan, 'enterprise')
  })

  test('all() returns tenants typed with the generic', async ({ assert }) => {
    const repo = mockTenantRepository<AcmeMetadata>()
    repo.add(buildTestTenant<AcmeMetadata>({ metadata: { plan: 'free', trialEndsAt: null, features: [] } }))
    repo.add(buildTestTenant<AcmeMetadata>({ metadata: { plan: 'pro', trialEndsAt: null, features: [] } }))

    const tenants = await repo.all()
    const plans = tenants.map((t) => t.metadata?.plan).sort()
    assert.deepEqual(plans, ['free', 'pro'])
  })

  test('create() returns a tenant carrying the generic shape', async ({ assert }) => {
    const repo = mockTenantRepository<AcmeMetadata>()
    const tenant = await repo.create({ name: 'New', email: 'n@e.c', status: 'active' })
    // Even when not seeded, the type allows reading metadata?.plan without a cast.
    assert.isUndefined(tenant.metadata)
  })
})
