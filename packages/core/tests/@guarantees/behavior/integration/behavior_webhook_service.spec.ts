import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { WebhookService, verifyWebhookSignature } from '@adonisjs-lasagna/saas-tenancy/services'
import { writeSecret } from '@adonisjs-lasagna/saas-tenancy'
import { encrypt } from '@adonisjs-lasagna/saas-tenancy/internal'
import { SafeFetchError, type SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { makeDelivery, makeHook } from '../../../helpers/webhook_doubles.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * Delivery is exercised through the WebhookService transport seam, not by
 * monkeypatching `globalThis.fetch`. The production transport is the pinned
 * `safeFetch`, which connects via `node:https.request` and never touches the
 * global `fetch`, so stubbing that global would silently test nothing. Injecting
 * the transport keeps these assertions on the real `send()` state machine while
 * the SSRF-block and secret-fail-closed paths below still run against the real
 * `safeFetch` default (a double would bypass the very guard they assert).
 */
interface TransportCall {
  url: string
  opts: SafeFetchOptions
}

/** A transport double that returns a fixed Response and records each call. */
function recordingTransport(status: number, body = '{}') {
  const calls: TransportCall[] = []
  const transport = async (url: string, opts: SafeFetchOptions): Promise<Response> => {
    calls.push({ url, opts })
    return new Response(body, { status })
  }
  return { calls, transport }
}

/**
 * A transport double that throws, to exercise the network-error path. The caller
 * passes the exact error to throw so a test can reproduce the precise shape the
 * production transport raises: `safeFetch` surfaces a transient connection
 * failure as `SafeFetchError('network_error', ..., retryable=true)`, which must
 * fall through to the retry branch just like a generic Error.
 */
function throwingTransport(error: Error) {
  const calls: TransportCall[] = []
  const transport = async (url: string, opts: SafeFetchOptions): Promise<Response> => {
    calls.push({ url, opts })
    throw error
  }
  return { calls, transport }
}

function headersOf(call: TransportCall): Record<string, string> {
  return (call.opts.headers ?? {}) as Record<string, string>
}

test.group('WebhookService.send() — delivery state machine', () => {
  test('refuses to deliver to an SSRF-unsafe url and fails closed without delivering', async ({
    assert,
  }) => {
    // Real default transport (safeFetch): a cloud-metadata IP is the kind of
    // target the SSRF guard must block at the delivery boundary even when the URL
    // was persisted bypassing the admin controller (direct service call, prior
    // version, DNS rebind). The block lives inside safeFetch, so this case runs
    // against the real transport rather than a double.
    const svc = new WebhookService()
    const hook = makeHook({ url: 'https://169.254.169.254/latest/meta-data/' })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
    assert.isNull(delivery.nextRetryAt)
  })

  test('sets status to success on 2xx response', async ({ assert }) => {
    const { transport } = recordingTransport(200)
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery()

    await svc.send(makeHook() as any, delivery as any)

    assert.equal(delivery.status, 'success')
    assert.equal(delivery.statusCode, 200)
  })

  test('sets status to retrying on non-2xx response when attempts remain', async ({ assert }) => {
    const { transport } = recordingTransport(500)
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery({ attempt: 1 })

    await svc.send(makeHook() as any, delivery as any)

    assert.equal(delivery.status, 'retrying')
    assert.equal(delivery.statusCode, 500)
    assert.equal(delivery.attempt, 2)
    assert.isNotNull(delivery.nextRetryAt)
  })

  test('sets status to failed on non-2xx response when max attempts reached', async ({
    assert,
  }) => {
    const { transport } = recordingTransport(500)
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery({ attempt: 5 })

    await svc.send(makeHook() as any, delivery as any)

    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.statusCode, 500)
  })

  test('sets status to retrying on network error when attempts remain', async ({ assert }) => {
    // The exact shape safeFetch raises on a transient connection failure: a
    // retryable SafeFetchError must fall through to the retry branch (send()
    // only fails closed on a NON-retryable SafeFetchError).
    const { transport } = throwingTransport(
      new SafeFetchError('network_error', 'Connection refused', true)
    )
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery({ attempt: 2 })

    await svc.send(makeHook() as any, delivery as any)

    assert.equal(delivery.status, 'retrying')
    assert.isNull(delivery.statusCode)
    assert.include(String(delivery.responseBody), 'Connection refused')
    assert.equal(delivery.attempt, 3)
  })

  test('sets status to failed on network error when max attempts reached', async ({ assert }) => {
    // A generic (non-SafeFetchError) throw also falls through to the retry path,
    // which at the attempt cap resolves to failed. Covers the generic branch
    // alongside the typed-SafeFetchError case above.
    const { transport } = throwingTransport(new Error('ECONNREFUSED'))
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery({ attempt: 5 })

    await svc.send(makeHook() as any, delivery as any)

    assert.equal(delivery.status, 'failed')
    assert.isNull(delivery.statusCode)
  })

  test('does not follow a 3xx redirect: a 300..399 is a permanent failure', async ({ assert }) => {
    // safeFetch never follows a redirect (the pinned transport surfaces the 3xx
    // itself); send() treats it as terminal. The double returns a 302 to prove
    // send() classifies it as a permanent, non-retryable failure.
    const { transport, calls } = recordingTransport(302)
    const svc = new WebhookService({ transport })
    const delivery = makeDelivery()

    await svc.send(makeHook() as any, delivery as any)

    // The never-follow guarantee itself lives in safeFetch; here we assert send()
    // makes exactly one transport call and classifies the 3xx itself, so it never
    // grows a redirect-follow loop of its own.
    assert.equal(calls.length, 1, 'send() makes one transport call and classifies the 3xx itself')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_redirect:302/)
    assert.isNull(delivery.nextRetryAt)
  })

  test('adds HMAC signature header when hook has a secret', async ({ assert }) => {
    const secret = 'webhook-signing-secret'
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    const hook = makeHook({ secret: writeSecret(secret, 'webhookSecret') })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    const headers = headersOf(calls[0]!)
    assert.property(headers, 'x-webhook-signature')

    const body = JSON.stringify(delivery.payload)
    const expectedSig = createHmac('sha256', secret).update(body).digest('hex')
    assert.equal(headers['x-webhook-signature'], expectedSig)
  })

  test('fails closed on a corrupted secret and never delivers', async ({ assert }) => {
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    const valid = writeSecret('webhook-signing-secret', 'webhookSecret')
    // Flip the final ciphertext hex char so the GCM auth-tag check fails.
    const corrupted = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a')
    const hook = makeHook({ secret: corrupted })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(calls.length, 0, 'a secret that cannot be decrypted must never be signed or sent')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /secret_decrypt_failed/)
    assert.isNull(delivery.statusCode)
    assert.isNull(delivery.nextRetryAt)
  })

  test('fails closed on a plaintext secret instead of signing with raw bytes', async ({
    assert,
  }) => {
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    // A secret that was never written through writeSecret() (the old plaintext path).
    const hook = makeHook({ secret: 'raw-plaintext-secret' })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(
      calls.length,
      0,
      'a plaintext secret must fail closed, not be used as a raw HMAC key'
    )
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /secret_decrypt_failed/)
    assert.isNull(delivery.nextRetryAt)
  })

  test('does not add signature header when hook has no secret', async ({ assert }) => {
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    const hook = makeHook({ secret: null })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.notProperty(headersOf(calls[0]!), 'x-webhook-signature')
  })

  test('always sends content-type, x-webhook-event and x-delivery-id headers', async ({
    assert,
  }) => {
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    const hook = makeHook()
    const delivery = makeDelivery({ event: 'order.placed' })

    await svc.send(hook as any, delivery as any)

    const headers = headersOf(calls[0]!)
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['x-webhook-event'], 'order.placed')
    assert.equal(headers['x-delivery-id'], delivery.id)
  })

  test('stores response body from successful request', async ({ assert }) => {
    const responsePayload = JSON.stringify({ received: true })
    const { transport } = recordingTransport(200, responsePayload)
    const svc = new WebhookService({ transport })

    const hook = makeHook()
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.responseBody, responsePayload)
  })
})

test.group('WebhookService — encryption', () => {
  test('encrypt utility produces an enc_v2: prefixed value', ({ assert }) => {
    const secret = 'my-webhook-secret'
    const encrypted = encrypt(secret)
    assert.isTrue(encrypted.startsWith('enc_v2:'))
    assert.notEqual(encrypted, secret)
  })
})

test.group('WebhookService.send() — exponential backoff bounds', () => {
  // Mirror the constants in src/services/webhook_service.ts so a future
  // change makes both numbers visible in the same review.
  const BACKOFF_BASE = [10, 60, 300, 1800, 7200] as const
  const JITTER_FRACTION = 0.2

  // A transport that always reports a 500 so each attempt schedules a retry.
  const failingSvc = () =>
    new WebhookService({ transport: async () => new Response('{}', { status: 500 }) })

  for (let attempt = 1; attempt <= BACKOFF_BASE.length; attempt++) {
    test(`attempt ${attempt} schedules nextRetryAt within ±${JITTER_FRACTION * 100}% of ${BACKOFF_BASE[attempt - 1]}s`, async ({
      assert,
    }) => {
      const before = Date.now()
      const hook = makeHook()
      const delivery = makeDelivery({ attempt })

      await failingSvc().send(hook as any, delivery as any)

      // Last attempt has no follow-up retry — status is 'failed' and
      // nextRetryAt stays unset.
      if (attempt === BACKOFF_BASE.length) {
        assert.equal(delivery.status, 'failed')
        return
      }
      assert.equal(delivery.status, 'retrying')
      assert.equal(delivery.attempt, attempt + 1, 'attempt counter must advance by 1')

      const nextRetryAt = (delivery.nextRetryAt as any).toMillis()
      const expectedMs = BACKOFF_BASE[attempt - 1]! * 1000
      const window = expectedMs * JITTER_FRACTION
      const elapsed = nextRetryAt - before
      assert.isAtLeast(
        elapsed,
        expectedMs - window - 100,
        `nextRetryAt is too soon: elapsed=${elapsed}ms, expected ≥ ${expectedMs - window - 100}ms`
      )
      assert.isAtMost(
        elapsed,
        expectedMs + window + 100,
        `nextRetryAt is too far: elapsed=${elapsed}ms, expected ≤ ${expectedMs + window + 100}ms`
      )
    })
  }
})

test.group('WebhookService.processRetries() — dead-letter behaviour (real DB)', (group) => {
  const cleanup: { tenantId?: string; webhookId?: string }[] = []

  group.each.teardown(async () => {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    while (cleanup.length) {
      const c = cleanup.pop()!
      if (c.webhookId) {
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
      }
      if (c.tenantId) {
        await db.connection('backoffice').query().from('tenants').where('id', c.tenantId).delete()
      }
    }
  })

  test('a delivery in status=failed is NOT retried by processRetries()', async ({ assert }) => {
    const { createTestTenant } = await import('../../../helpers/tenant.js')
    const { TenantWebhook, TenantWebhookDelivery } =
      await import('@adonisjs-lasagna/saas-tenancy/models/satellites')

    const tenant = await createTestTenant()
    const hook = await TenantWebhook.create({
      tenantId: tenant.id,
      url: 'http://127.0.0.1:1/never-listens',
      events: ['user.created'],
      enabled: true,
    })
    cleanup.push({ tenantId: tenant.id, webhookId: hook.id })

    // Seed a delivery that has already been declared dead — status=failed,
    // attempt at the cap. processRetries() must skip it.
    const dead = await TenantWebhookDelivery.create({
      webhookId: hook.id,
      event: 'user.created',
      payload: { userId: '1' },
      status: 'failed',
      attempt: 5,
      nextRetryAt: null,
    })

    // Inject a recording transport so we can assert the dead row was never even
    // SELECTED (not just "left unchanged"). The sweep is cross-tenant, so other
    // rows may legitimately be delivered; we assert specifically that OUR delivery
    // id never reached the transport.
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    await svc.processRetries()

    const sentDeliveryIds = calls.map((c) => headersOf(c)['x-delivery-id'])
    assert.notInclude(
      sentDeliveryIds,
      dead.id,
      'processRetries must not retry the dead-letter delivery'
    )
    const fresh = await TenantWebhookDelivery.find(dead.id)
    assert.equal(fresh!.status, 'failed', 'failed delivery must remain failed')
    assert.equal(fresh!.attempt, 5, 'attempt counter must not advance')
  })

  test('a delivery in status=retrying with future nextRetryAt is NOT retried yet', async ({
    assert,
  }) => {
    const { createTestTenant } = await import('../../../helpers/tenant.js')
    const { TenantWebhook, TenantWebhookDelivery } =
      await import('@adonisjs-lasagna/saas-tenancy/models/satellites')
    const { DateTime } = await import('luxon')

    const tenant = await createTestTenant()
    const hook = await TenantWebhook.create({
      tenantId: tenant.id,
      url: 'http://127.0.0.1:1/never-listens',
      events: ['user.created'],
      enabled: true,
    })
    cleanup.push({ tenantId: tenant.id, webhookId: hook.id })

    const future = await TenantWebhookDelivery.create({
      webhookId: hook.id,
      event: 'user.created',
      payload: { userId: '1' },
      status: 'retrying',
      attempt: 2,
      nextRetryAt: DateTime.utc().plus({ minutes: 30 }),
    })

    // Same seam assertion as the dead-letter case: a not-yet-due row must never
    // reach the transport, independent of the row-state checks below.
    const { transport, calls } = recordingTransport(200)
    const svc = new WebhookService({ transport })

    await svc.processRetries()

    const sentDeliveryIds = calls.map((c) => headersOf(c)['x-delivery-id'])
    assert.notInclude(sentDeliveryIds, future.id, 'a not-yet-due delivery must not be retried')
    const fresh = await TenantWebhookDelivery.find(future.id)
    assert.equal(fresh!.attempt, 2)
    assert.equal(fresh!.status, 'retrying')
  })
})

test.group('WebhookService — verifyWebhookSignature (receiver-side)', () => {
  const secret = 'shared-receiver-secret'
  const body = JSON.stringify({ userId: '123', event: 'user.created' })
  const validSig = createHmac('sha256', secret).update(body).digest('hex')

  test('accepts a signature produced over the same bytes with the same secret', ({ assert }) => {
    assert.isTrue(verifyWebhookSignature(body, validSig, secret))
  })

  test('rejects when the body has been mutated in transit', ({ assert }) => {
    const tampered = body.replace('123', '666')
    assert.isFalse(verifyWebhookSignature(tampered, validSig, secret))
  })

  test('rejects when the secret is wrong', ({ assert }) => {
    assert.isFalse(verifyWebhookSignature(body, validSig, 'attacker-guessed-secret'))
  })

  test('rejects a missing or empty signature header', ({ assert }) => {
    assert.isFalse(verifyWebhookSignature(body, null, secret))
    assert.isFalse(verifyWebhookSignature(body, undefined, secret))
    assert.isFalse(verifyWebhookSignature(body, '', secret))
  })

  test('rejects a malformed (wrong-length / non-hex) signature', ({ assert }) => {
    assert.isFalse(verifyWebhookSignature(body, 'too-short', secret))
    assert.isFalse(verifyWebhookSignature(body, 'g'.repeat(64), secret), 'non-hex chars')
    assert.isFalse(verifyWebhookSignature(body, validSig + 'a', secret), 'extra char')
  })

  test('round-trip: WebhookService.send() produces a signature this helper accepts', async ({
    assert,
  }) => {
    let captured: { body: string; sig: string } | null = null
    const transport = async (_url: string, opts: SafeFetchOptions): Promise<Response> => {
      const headers = (opts.headers ?? {}) as Record<string, string>
      captured = { body: String(opts.body ?? ''), sig: headers['x-webhook-signature']! }
      return new Response('{}', { status: 200 })
    }
    const svc = new WebhookService({ transport })
    const hook = makeHook({ secret: writeSecret(secret, 'webhookSecret') })
    const delivery = makeDelivery()
    await svc.send(hook as any, delivery as any)

    assert.isNotNull(captured, 'transport was not invoked')
    assert.isTrue(
      verifyWebhookSignature(captured!.body, captured!.sig, secret),
      'sender signature must validate with the public verifier'
    )
  })
})
