import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  WebhookService,
  WebhookTransformerRegistry,
  WEBHOOKS_CONTRACT_VERSION,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { encrypt } from '@adonisjs-lasagna/saas-tenancy'
import {
  TenantWebhook,
  TenantWebhookDelivery,
} from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant } from '../../../integration/helpers/tenant.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * The webhook PayloadTransformer surface. The transform runs ONCE, in
 * `dispatch()` before the delivery row is persisted, so the stored payload is
 * exactly what `send()` signs and what retries re-send. A transformer that
 * throws records a failed, no-retry delivery and never delivers an untransformed
 * payload. With no transformer registered, behavior is unchanged.
 */
test.group('WebhookService — payload transformers (integration)', (group) => {
  const svc = new WebhookService()
  const cleanup: { tenantId: string; webhookId: string }[] = []
  let originalFetch: typeof globalThis.fetch

  group.each.setup(() => {
    originalFetch = globalThis.fetch
  })

  group.each.teardown(async () => {
    globalThis.fetch = originalFetch
    const registry = await app.container.make(WebhookTransformerRegistry)
    registry.clear()
    while (cleanup.length) {
      const c = cleanup.pop()!
      await db
        .connection('backoffice')
        .query()
        .from('tenant_webhook_deliveries')
        .where('webhook_id', c.webhookId)
        .delete()
      await db
        .connection('backoffice')
        .query()
        .from('tenant_webhooks')
        .where('id', c.webhookId)
        .delete()
      await db.connection('backoffice').query().from('tenants').where('id', c.tenantId).delete()
    }
  })

  async function makeWebhook(tenantId: string) {
    const hook = await TenantWebhook.create({
      tenantId,
      // Loopback → the SSRF guard fails the delivery, but `deliver()` persists
      // the (transformed) payload BEFORE `send()` runs, which is what we assert.
      url: 'http://127.0.0.1:1/never-listens',
      events: ['user.created'],
      enabled: true,
      secret: encrypt('s3cr3t'),
    })
    cleanup.push({ tenantId, webhookId: hook.id })
    return hook
  }

  test('the transformer rewrites the PERSISTED payload (so signature + retries match)', async ({
    assert,
  }) => {
    const registry = await app.container.make(WebhookTransformerRegistry)
    registry.register({
      name: 'enrich',
      contractVersion: WEBHOOKS_CONTRACT_VERSION,
      transform: (event, p) => ({ ...p, event, enriched: true }),
    })

    const t = await createTestTenant()
    const hook = await makeWebhook(t.id)

    await svc.dispatch(t.id, 'user.created', { id: 7 })

    const delivery = await TenantWebhookDelivery.query().where('webhook_id', hook.id).first()
    assert.isNotNull(delivery)
    assert.deepInclude(delivery!.payload as Record<string, unknown>, {
      id: 7,
      event: 'user.created',
      enriched: true,
    })
  })

  test('a throwing transformer records a failed delivery and never delivers', async ({
    assert,
  }) => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    const registry = await app.container.make(WebhookTransformerRegistry)
    registry.register({
      name: 'kaboom',
      contractVersion: WEBHOOKS_CONTRACT_VERSION,
      transform: () => {
        throw new Error('bad transform')
      },
    })

    const t = await createTestTenant()
    const hook = await makeWebhook(t.id)

    await svc.dispatch(t.id, 'user.created', { id: 7 })

    assert.isFalse(fetchCalled, 'must not deliver an untransformed payload')
    const delivery = await TenantWebhookDelivery.query().where('webhook_id', hook.id).first()
    assert.isNotNull(delivery)
    assert.equal(delivery!.status, 'failed')
    assert.match(String(delivery!.responseBody), /transform_failed/)
    assert.isNull(delivery!.nextRetryAt)
  })
})
