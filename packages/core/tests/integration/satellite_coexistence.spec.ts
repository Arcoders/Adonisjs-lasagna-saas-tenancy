import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { DateTime } from 'luxon'
import {
  AuditLogService,
  FeatureFlagService,
  BrandingService,
  WebhookService,
  MetricsService,
  QuotaService,
} from '@adonisjs-lasagna/saas-tenancy/services'
import {
  TenantFeatureFlag,
  TenantBranding,
  TenantWebhook,
  TenantPlan,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { BillingService, MockStripe, StripeCustomer } from '@adonisjs-lasagna/billing'
import { setupBillingConfig, clearBillingTables } from './billing/helpers.js'
import { createTestTenant, destroyTestTenant } from './helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The user's real question: "I installed audit + webhooks; can I add billing,
 * metrics, quotas, … later without breaking what's already there?" This spec
 * proves the runtime answer is yes. It drives every satellite for the *same*
 * tenant in one session and asserts each persists to its own backoffice table
 * (or Redis, for metrics) with no cross-interference, then proves rows stay
 * isolated between tenants, and finally that adding billing to a tenant that
 * already uses the other satellites leaves them untouched.
 *
 * Billing uses MockStripe (no real SDK, fake keys) per the package convention.
 */

const TODAY = DateTime.utc().toFormat('yyyy-MM-dd')

async function cleanupTenant(id: string): Promise<void> {
  await TenantFeatureFlag.query().where('tenant_id', id).delete()
  await TenantBranding.query().where('tenant_id', id).delete()
  await TenantWebhook.query().where('tenant_id', id).delete()

  // tenant_audit_logs is append-only (DELETE trigger). Disable it to clean up,
  // mirroring tests/integration/services/audit_log_service.spec.ts.
  await db.rawQuery(
    'ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_delete'
  )
  try {
    await db.connection('backoffice').query().from('tenant_audit_logs').where('tenant_id', id).delete()
  } finally {
    await db.rawQuery(
      'ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_delete'
    )
  }

  const keys = await redis.keys(`metrics:${id}:*`)
  if (keys.length) await redis.del(...keys)

  await destroyTestTenant(id)
}

function asTenant(t: { id: string; name: string; email: string }): TenantModelContract {
  return { id: t.id, name: t.name, email: t.email } as unknown as TenantModelContract
}

test.group('Satellite coexistence (integration)', (group) => {
  const tenants: string[] = []
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    // tenant_plans + stripe_* hold FK refs to tenants — clear them before the
    // tenant rows go.
    await clearBillingTables()
    while (tenants.length) await cleanupTenant(tenants.pop()!)
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  test('every satellite persists for one tenant without interfering', async ({ assert }) => {
    const t = await createTestTenant()
    tenants.push(t.id)

    // audit
    await new AuditLogService().log({ tenantId: t.id, action: 'tenant.created', actorType: 'system' })
    // feature flags
    await new FeatureFlagService().set(t.id, 'beta_dashboard', true, { rollout: 10 })
    // branding
    await new BrandingService().upsert(t.id, { fromName: 'Acme', primaryColor: '#112233' })
    // webhooks
    await new WebhookService().registerWebhook(t.id, 'https://example.com/hooks', ['user.created'])
    // metrics (Redis-backed)
    await new MetricsService().increment(t.id, 'requests', 3)
    // quotas
    const quota = await app.container.make(QuotaService)
    await quota.assignPlan(t.id, 'pro')
    // billing (MockStripe — auto-creates the Stripe customer mirror)
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    await billing.createCheckoutSession(asTenant(t), {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
    })

    // Each satellite landed in its own store.
    const audit = await new AuditLogService().listForTenant(t.id, 1, 50)
    assert.equal(audit.meta.total, 1)
    assert.equal(audit.data[0].action, 'tenant.created')

    const flags = await new FeatureFlagService().listForTenant(t.id)
    assert.lengthOf(flags, 1)
    assert.equal(flags[0].flag, 'beta_dashboard')

    const branding = await new BrandingService().getForTenant(t.id)
    assert.equal(branding!.fromName, 'Acme')

    const hooks = await new WebhookService().listWebhooks(t.id)
    assert.lengthOf(hooks, 1)
    assert.equal(hooks[0].url, 'https://example.com/hooks')

    const metric = await redis.get(`metrics:${t.id}:${TODAY}:requests`)
    assert.equal(metric, '3')

    const plan = await TenantPlan.find(t.id)
    assert.equal(plan!.planName, 'pro')

    const customer = await StripeCustomer.find(t.id)
    assert.isNotNull(customer, 'billing created the Stripe customer mirror')
  })

  test('satellite rows stay isolated between tenants', async ({ assert }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    tenants.push(a.id, b.id)

    const audit = new AuditLogService()
    const flags = new FeatureFlagService()
    const quota = await app.container.make(QuotaService)

    await audit.log({ tenantId: a.id, action: 'a.event' })
    await flags.set(a.id, 'flag_a', true)
    await quota.assignPlan(a.id, 'pro')

    await audit.log({ tenantId: b.id, action: 'b.event' })
    await flags.set(b.id, 'flag_b', true)
    await quota.assignPlan(b.id, 'team')

    const auditA = await audit.listForTenant(a.id, 1, 50)
    assert.deepEqual(auditA.data.map((r: any) => r.action), ['a.event'])

    const flagsA = await flags.listForTenant(a.id)
    assert.deepEqual(flagsA.map((f) => f.flag), ['flag_a'])

    assert.equal((await TenantPlan.find(a.id))!.planName, 'pro')
    assert.equal((await TenantPlan.find(b.id))!.planName, 'team')
  })

  test('adding billing leaves pre-existing satellites untouched', async ({ assert }) => {
    const t = await createTestTenant()
    tenants.push(t.id)

    // "Already installed": audit + feature flag + branding + webhook.
    await new AuditLogService().log({ tenantId: t.id, action: 'pre.billing' })
    await new FeatureFlagService().set(t.id, 'existing_flag', true)
    await new BrandingService().upsert(t.id, { fromName: 'Before Billing' })
    await new WebhookService().registerWebhook(t.id, 'https://example.com/pre', ['user.created'])

    // "Newly added": billing.
    const billing = await app.container.make(BillingService)
    billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    await billing.createCheckoutSession(asTenant(t), {
      priceId: 'price_pro_monthly',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/cancel',
      allowUnknownPrices: true,
    })

    // The pre-existing satellites are intact and unchanged.
    assert.equal((await new AuditLogService().listForTenant(t.id, 1, 50)).meta.total, 1)
    assert.lengthOf(await new FeatureFlagService().listForTenant(t.id), 1)
    assert.equal((await new BrandingService().getForTenant(t.id))!.fromName, 'Before Billing')
    assert.lengthOf(await new WebhookService().listWebhooks(t.id), 1)
    // And billing is now present.
    assert.isNotNull(await StripeCustomer.find(t.id))
  })
})
