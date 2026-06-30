import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { WebhookService, verifyWebhookSignature } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantWebhook } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import type { SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { makeDelivery } from '../../../helpers/webhook_doubles.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * webhooks.md: "Generated when omitted; encrypted at rest". A webhook
 * registered without a secret must NOT silently produce unsigned
 * deliveries — the service generates one, stores it encrypted under the
 * webhook secret class, and returns the plaintext exactly once as
 * `generatedSecret`.
 */
test.group('WebhookService.registerWebhook() — secret generation', (group) => {
  const svc = new WebhookService()
  const created: string[] = []

  group.each.teardown(async () => {
    while (created.length) {
      const id = created.pop()!
      await TenantWebhook.query().where('id', id).delete()
    }
  })

  test('generates a signing secret when none is provided', async ({ assert }) => {
    const { hook, generatedSecret } = await svc.registerWebhook(
      randomUUID(),
      'https://example.com/hooks',
      ['user.created']
    )
    created.push(hook.id)

    assert.match(
      String(generatedSecret),
      /^[0-9a-f]{64}$/,
      'plaintext surfaced once, 32 random bytes'
    )
    assert.isString(hook.secret)
    assert.notInclude(String(hook.secret), generatedSecret!, 'stored value must be encrypted')
  })

  test('an empty-string secret counts as omitted — generated, never an empty HMAC key', async ({
    assert,
  }) => {
    const { hook, generatedSecret } = await svc.registerWebhook(
      randomUUID(),
      'https://example.com/hooks',
      ['user.created'],
      ''
    )
    created.push(hook.id)

    assert.match(String(generatedSecret), /^[0-9a-f]{64}$/)
  })

  test('deliveries from a generated-secret hook are signed and verifiable', async ({ assert }) => {
    const { hook, generatedSecret } = await svc.registerWebhook(
      randomUUID(),
      'https://example.com/hooks',
      ['user.created']
    )
    created.push(hook.id)

    // Inject a transport double: registerWebhook stored the secret under the
    // webhook class, so send() decrypts it per-class and signs the body. We
    // capture what the transport would have sent and verify the signature with
    // the once-disclosed generated secret.
    let sentBody = ''
    let signature: string | null = null
    const transport = async (_url: string, opts: SafeFetchOptions): Promise<Response> => {
      const headers = (opts.headers ?? {}) as Record<string, string>
      sentBody = String(opts.body ?? '')
      signature = headers['x-webhook-signature'] ?? null
      return new Response('{}', { status: 200 })
    }
    const sendSvc = new WebhookService({ transport })

    const delivery = makeDelivery({ payload: { hello: 'world' } })
    await sendSvc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'success')
    assert.isString(signature, 'delivery must carry x-webhook-signature')
    assert.isTrue(
      verifyWebhookSignature(sentBody, signature!, generatedSecret!),
      'the signature must verify against the once-disclosed generated secret'
    )
  })

  test('an explicitly provided secret is honored (no generation)', async ({ assert }) => {
    const { hook, generatedSecret } = await svc.registerWebhook(
      randomUUID(),
      'https://example.com/hooks',
      ['user.created'],
      'caller-chosen-secret'
    )
    created.push(hook.id)

    assert.isUndefined(generatedSecret)
    assert.isString(hook.secret)
  })
})
