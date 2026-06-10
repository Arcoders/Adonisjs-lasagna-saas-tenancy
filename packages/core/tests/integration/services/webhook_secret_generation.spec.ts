import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { WebhookService, verifyWebhookSignature } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantWebhook } from '@adonisjs-lasagna/saas-tenancy/models/satellites'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * webhooks.md: "Generated when omitted; encrypted at rest". A webhook
 * registered without a secret must NOT silently produce unsigned
 * deliveries — the service generates one, stores it encrypted, and
 * surfaces the plaintext exactly once via `$extras.generatedSecret`.
 */
test.group('WebhookService.registerWebhook() — secret generation', (group) => {
  const svc = new WebhookService()
  const created: string[] = []
  let originalFetch: typeof globalThis.fetch

  group.each.setup(() => {
    originalFetch = globalThis.fetch
  })

  group.each.teardown(async () => {
    globalThis.fetch = originalFetch
    while (created.length) {
      const id = created.pop()!
      await TenantWebhook.query().where('id', id).delete()
    }
  })

  test('generates a signing secret when none is provided', async ({ assert }) => {
    const hook = await svc.registerWebhook(randomUUID(), 'https://example.com/hooks', [
      'user.created',
    ])
    created.push(hook.id)

    const generated = (hook.$extras as { generatedSecret?: string }).generatedSecret
    assert.match(String(generated), /^[0-9a-f]{64}$/, 'plaintext surfaced once, 32 random bytes')
    assert.isString(hook.secret)
    assert.notInclude(String(hook.secret), generated!, 'stored value must be the encrypted form')
  })

  test('deliveries from a generated-secret hook are signed and verifiable', async ({ assert }) => {
    const hook = await svc.registerWebhook(randomUUID(), 'https://example.com/hooks', [
      'user.created',
    ])
    created.push(hook.id)
    const generated = (hook.$extras as { generatedSecret?: string }).generatedSecret!

    let sentBody = ''
    let signature: string | null = null
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '')
      signature = (init?.headers as Record<string, string>)?.['x-webhook-signature'] ?? null
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    const delivery = {
      id: randomUUID(),
      event: 'user.created',
      payload: { hello: 'world' },
      status: 'pending',
      attempt: 1,
      statusCode: null,
      responseBody: null,
      nextRetryAt: null,
      save: async () => {},
    }
    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'success')
    assert.isString(signature, 'delivery must carry x-webhook-signature')
    assert.isTrue(
      verifyWebhookSignature(sentBody, signature!, generated),
      'the signature must verify against the once-disclosed generated secret'
    )
  })

  test('an explicitly provided secret is honored (no generation, no $extras)', async ({
    assert,
  }) => {
    const hook = await svc.registerWebhook(
      randomUUID(),
      'https://example.com/hooks',
      ['user.created'],
      'caller-chosen-secret'
    )
    created.push(hook.id)

    assert.isUndefined((hook.$extras as { generatedSecret?: string }).generatedSecret)
    assert.isString(hook.secret)
  })
})
