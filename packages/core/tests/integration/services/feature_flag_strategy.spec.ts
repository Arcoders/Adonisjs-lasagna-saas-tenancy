import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import {
  FeatureFlagService,
  EvaluationStrategyRegistry,
  FEATURE_FLAGS_CONTRACT_VERSION,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantFeatureFlag } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

/**
 * The pluggable evaluation-strategy surface. The default path (no
 * `config.strategy`) must stay byte-identical to legacy `isEnabled`, and a
 * context-aware strategy must decide per call (never cached as a boolean).
 */
test.group('FeatureFlagService — evaluation strategies (integration)', (group) => {
  const svc = new FeatureFlagService()
  const cleanup: string[] = []

  // Track only what THIS group adds, so teardown unregisters exactly that and the
  // strategies never leak into the shared registry for later specs.
  const registeredHere: string[] = []

  group.setup(async () => {
    const registry = await app.container.make(EvaluationStrategyRegistry)
    if (!registry.has('force_off')) {
      registry.register({
        name: 'force_off',
        contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
        evaluate: () => false,
      })
      registeredHere.push('force_off')
    }
    if (!registry.has('ctx_gate')) {
      registry.register({
        name: 'ctx_gate',
        contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
        evaluate: (_record, ctx) => ctx.userId === 'vip',
      })
      registeredHere.push('ctx_gate')
    }
  })

  group.teardown(async () => {
    const registry = await app.container.make(EvaluationStrategyRegistry)
    for (const name of registeredHere.splice(0)) registry.unregister(name)
  })

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await TenantFeatureFlag.query().where('tenant_id', id).delete()
      await destroyTestTenant(id)
    }
  })

  test('a flag with no config.strategy uses the built-in default', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)
    await svc.set(t.id, 'plain_on', true)
    await svc.set(t.id, 'plain_off', false)
    assert.isTrue(await svc.isEnabled(t.id, 'plain_on'))
    assert.isFalse(await svc.isEnabled(t.id, 'plain_off'))
  })

  test('config.strategy selects a custom strategy (overrides the stored boolean)', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)
    // Stored enabled=true, but force_off returns false.
    await svc.set(t.id, 'gated', true, { strategy: 'force_off' })
    assert.isFalse(await svc.isEnabled(t.id, 'gated'))
  })

  test('a context-aware strategy decides per call', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)
    await svc.set(t.id, 'ctx', true, { strategy: 'ctx_gate' })
    assert.isTrue(await svc.isEnabled(t.id, 'ctx', { userId: 'vip' }))
    assert.isFalse(await svc.isEnabled(t.id, 'ctx', { userId: 'other' }))
  })

  test('an unknown strategy name falls back to the default', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)
    await svc.set(t.id, 'typo', true, { strategy: 'does_not_exist' })
    assert.isTrue(await svc.isEnabled(t.id, 'typo'))
  })
})
