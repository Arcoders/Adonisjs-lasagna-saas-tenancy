import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { createHmac } from 'node:crypto'
import { WebhookService, verifyWebhookSignature } from '@adonisjs-lasagna/saas-tenancy/services'
import { encrypt } from '@adonisjs-lasagna/saas-tenancy'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

type FakeFetch = (
  url: unknown,
  init?: RequestInit
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

function makeFetch(status: number, body = '{}'): FakeFetch {
  return async (_url, _init) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'user.created',
    payload: { userId: '123' },
    status: 'pending' as const,
    attempt: 1,
    statusCode: null as number | null,
    responseBody: null as string | null,
    nextRetryAt: null as unknown,
    save: async () => {},
    ...overrides,
  }
}

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    url: 'https://example.com/webhook',
    events: ['user.created'],
    secret: null as string | null,
    enabled: true,
    ...overrides,
  }
}

test.group('WebhookService.send() — delivery state machine', (group) => {
  let originalFetch: typeof globalThis.fetch
  const svc = new WebhookService()

  group.each.setup(() => {
    originalFetch = globalThis.fetch
  })

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
  })

  test('refuses to deliver to an SSRF-unsafe url and never calls fetch', async ({ assert }) => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    // Cloud metadata IP — the kind of target the SSRF guard must block at the
    // fetch boundary even when the URL was persisted bypassing the admin
    // controller (direct service call, prior version, DNS rebind).
    const hook = makeHook({ url: 'http://169.254.169.254/latest/meta-data/' })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.isFalse(fetchCalled, 'fetch must not be invoked for an unsafe url')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
    assert.isNull(delivery.nextRetryAt)
  })

  test('sets status to success on 2xx response', async ({ assert }) => {
    globalThis.fetch = makeFetch(200) as unknown as typeof fetch
    const hook = makeHook()
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'success')
    assert.equal(delivery.statusCode, 200)
  })

  test('sets status to retrying on non-2xx response when attempts remain', async ({ assert }) => {
    globalThis.fetch = makeFetch(500) as unknown as typeof fetch
    const hook = makeHook()
    const delivery = makeDelivery({ attempt: 1 })

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'retrying')
    assert.equal(delivery.statusCode, 500)
    assert.equal(delivery.attempt, 2)
    assert.isNotNull(delivery.nextRetryAt)
  })

  test('sets status to failed on non-2xx response when max attempts reached', async ({
    assert,
  }) => {
    globalThis.fetch = makeFetch(500) as unknown as typeof fetch
    const hook = makeHook()
    const delivery = makeDelivery({ attempt: 5 })

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.statusCode, 500)
  })

  test('sets status to retrying on network error when attempts remain', async ({ assert }) => {
    globalThis.fetch = (async () => {
      throw new Error('Connection refused')
    }) as unknown as typeof fetch

    const hook = makeHook()
    const delivery = makeDelivery({ attempt: 2 })

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'retrying')
    assert.isNull(delivery.statusCode)
    assert.include(String(delivery.responseBody), 'Connection refused')
    assert.equal(delivery.attempt, 3)
  })

  test('sets status to failed on network error when max attempts reached', async ({ assert }) => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const hook = makeHook()
    const delivery = makeDelivery({ attempt: 5 })

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.status, 'failed')
    assert.isNull(delivery.statusCode)
  })

  test('adds HMAC signature header when hook has a secret', async ({ assert }) => {
    const secret = 'webhook-signing-secret'
    const encryptedSecret = encrypt(secret)
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      Object.assign(capturedHeaders, init?.headers as Record<string, string>)
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    const hook = makeHook({ secret: encryptedSecret })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.property(capturedHeaders, 'x-webhook-signature')

    const body = JSON.stringify(delivery.payload)
    const expectedSig = createHmac('sha256', secret).update(body).digest('hex')
    assert.equal(capturedHeaders['x-webhook-signature'], expectedSig)
  })

  test('does not add signature header when hook has no secret', async ({ assert }) => {
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      Object.assign(capturedHeaders, init?.headers as Record<string, string>)
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    const hook = makeHook({ secret: null })
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.notProperty(capturedHeaders, 'x-webhook-signature')
  })

  test('always sends content-type, x-webhook-event and x-delivery-id headers', async ({
    assert,
  }) => {
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      Object.assign(capturedHeaders, init?.headers as Record<string, string>)
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    const hook = makeHook()
    const delivery = makeDelivery({ event: 'order.placed' })

    await svc.send(hook as any, delivery as any)

    assert.equal(capturedHeaders['content-type'], 'application/json')
    assert.equal(capturedHeaders['x-webhook-event'], 'order.placed')
    assert.equal(capturedHeaders['x-delivery-id'], delivery.id)
  })

  test('stores response body from successful request', async ({ assert }) => {
    const responsePayload = JSON.stringify({ received: true })
    globalThis.fetch = makeFetch(200, responsePayload) as unknown as typeof fetch

    const hook = makeHook()
    const delivery = makeDelivery()

    await svc.send(hook as any, delivery as any)

    assert.equal(delivery.responseBody, responsePayload)
  })
})

test.group('WebhookService — encryption', () => {
  test('encrypt utility produces an enc_v1: prefixed value', ({ assert }) => {
    const secret = 'my-webhook-secret'
    const encrypted = encrypt(secret)
    assert.isTrue(encrypted.startsWith('enc_v1:'))
    assert.notEqual(encrypted, secret)
  })
})

test.group('WebhookService.send() — exponential backoff bounds', (group) => {
  let originalFetch: typeof globalThis.fetch
  const svc = new WebhookService()
  // Mirror the constants in src/services/webhook_service.ts so a future
  // change makes both numbers visible in the same review.
  const BACKOFF_BASE = [10, 60, 300, 1800, 7200] as const
  const JITTER_FRACTION = 0.2

  group.each.setup(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = makeFetch(500) as unknown as typeof fetch
  })
  group.each.teardown(() => {
    globalThis.fetch = originalFetch
  })

  for (let attempt = 1; attempt <= BACKOFF_BASE.length; attempt++) {
    test(`attempt ${attempt} schedules nextRetryAt within ±${JITTER_FRACTION * 100}% of ${BACKOFF_BASE[attempt - 1]}s`, async ({
      assert,
    }) => {
      const before = Date.now()
      const hook = makeHook()
      const delivery = makeDelivery({ attempt })

      await svc.send(hook as any, delivery as any)

      // Last attempt has no follow-up retry — status is 'failed' and
      // nextRetryAt stays unset.
      if (attempt === BACKOFF_BASE.length) {
        assert.equal(delivery.status, 'failed')
        return
      }
      assert.equal(delivery.status, 'retrying')
      assert.equal(delivery.attempt, attempt + 1, 'attempt counter must advance by 1')

      const nextRetryAt = (delivery.nextRetryAt as any).toMillis()
      const expectedMs = BACKOFF_BASE[attempt - 1] * 1000
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
  const svc = new WebhookService()
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
    const { createTestTenant } = await import('../helpers/tenant.js')
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

    // Track which delivery ids the network was actually invoked for.
    // We can't assume an empty DB (other test groups can leave their
    // own retrying rows behind), so we assert specifically that OUR
    // delivery was not touched.
    const calledFor: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.['x-delivery-id']) calledFor.push(headers['x-delivery-id'])
      return { ok: true, status: 200, text: async () => '{}' } as any
    }) as unknown as typeof fetch
    try {
      await svc.processRetries()
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.notInclude(calledFor, dead.id, 'processRetries must not retry the dead-letter delivery')
    const fresh = await TenantWebhookDelivery.find(dead.id)
    assert.equal(fresh!.status, 'failed', 'failed delivery must remain failed')
    assert.equal(fresh!.attempt, 5, 'attempt counter must not advance')
  })

  test('a delivery in status=retrying with future nextRetryAt is NOT retried yet', async ({
    assert,
  }) => {
    const { createTestTenant } = await import('../helpers/tenant.js')
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

    const calledFor: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.['x-delivery-id']) calledFor.push(headers['x-delivery-id'])
      return { ok: true, status: 200, text: async () => '{}' } as any
    }) as unknown as typeof fetch
    try {
      await svc.processRetries()
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.notInclude(
      calledFor,
      future.id,
      'next_retry_at is in the future — must not be retried yet'
    )
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
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      captured = { body: String(init?.body ?? ''), sig: headers['x-webhook-signature'] }
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch
    try {
      const svc = new WebhookService()
      const hook = makeHook({ secret: encrypt(secret) })
      const delivery = makeDelivery()
      await svc.send(hook as any, delivery as any)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.isNotNull(captured, 'fetch was not invoked')
    assert.isTrue(
      verifyWebhookSignature(captured!.body, captured!.sig, secret),
      'sender signature must validate with the public verifier'
    )
  })
})
