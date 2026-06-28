import { test } from '@japa/runner'
import TrackMetricsMiddleware from '../../../src/middleware/track_metrics_middleware.js'
import { setupTestConfig } from '../../helpers/config.js'

function makeRequest(headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    ip: () => '127.0.0.1',
    hostname: () => (lower['host'] ?? '').split(':')[0],
    url: () => '/',
    header: (key: string) => lower[key.toLowerCase()] ?? null,
    qs: () => ({}),
    input: () => undefined,
  } as any
}

function makeResponse(status = 200, contentLength?: string | number) {
  const headers: Record<string, string | number> = {}
  if (contentLength !== undefined) headers['content-length'] = contentLength
  return {
    getStatus: () => status,
    getHeader: (name: string) => headers[name.toLowerCase()],
  } as any
}

class FakeMetrics {
  increments: Array<{ tenantId: string; metric: string; amount: number }> = []
  bandwidth: Array<{ tenantId: string; bytes: number }> = []
  incrementImpl: (() => void) | null = null
  bandwidthImpl: (() => void) | null = null

  async increment(tenantId: string, metric: 'requests' | 'errors', amount = 1) {
    this.incrementImpl?.()
    this.increments.push({ tenantId, metric, amount })
  }
  async trackBandwidth(tenantId: string, bytes: number) {
    this.bandwidthImpl?.()
    this.bandwidth.push({ tenantId, bytes })
  }
}

class TestableTrackMetrics extends TrackMetricsMiddleware {
  constructor(
    public fake: FakeMetrics,
    private tenantIdOverride: string | undefined,
    private testEnv = false
  ) {
    super()
  }
  protected isTestEnv(): boolean {
    return this.testEnv
  }
  protected currentTenantId(): string | undefined {
    return this.tenantIdOverride
  }
  protected async getMetrics(): Promise<any> {
    return this.fake
  }
}

const TID = 'ctx-tenant'

test.group('TrackMetricsMiddleware', (group) => {
  group.each.setup(() => {
    setupTestConfig()
  })

  test('records exactly one request on a 2xx response', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID)
    let nextCalled = false

    await m.handle({ request: makeRequest(), response: makeResponse(200) } as any, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled)
    assert.deepEqual(
      fake.increments.map((i) => i.metric),
      ['requests']
    )
    assert.equal(fake.increments[0].tenantId, TID)
  })

  test('records request + error on a 500 response', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID)

    await m.handle({ request: makeRequest(), response: makeResponse(500) } as any, async () => {})

    assert.deepEqual(
      fake.increments.map((i) => i.metric),
      ['requests', 'errors']
    )
  })

  test('honors a custom errorThreshold (counts a 404 as an error)', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID)

    await m.handle({ request: makeRequest(), response: makeResponse(404) } as any, async () => {}, {
      errorThreshold: 400,
    })

    assert.deepEqual(
      fake.increments.map((i) => i.metric),
      ['requests', 'errors']
    )
  })

  test('tracks bandwidth from a numeric Content-Length', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID)

    await m.handle(
      { request: makeRequest(), response: makeResponse(200, '2048') } as any,
      async () => {}
    )

    assert.deepEqual(fake.bandwidth, [{ tenantId: TID, bytes: 2048 }])
  })

  test('skips bandwidth when Content-Length is absent, non-numeric, or non-positive', async ({
    assert,
  }) => {
    for (const cl of [undefined, 'abc', '-5', '0'] as const) {
      const fake = new FakeMetrics()
      const m = new TestableTrackMetrics(fake, TID)
      await m.handle(
        { request: makeRequest(), response: makeResponse(200, cl) } as any,
        async () => {}
      )
      assert.lengthOf(fake.bandwidth, 0, `content-length=${String(cl)} must not track bandwidth`)
    }
  })

  test('records nothing when no tenant resolves', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, undefined)
    let nextCalled = false

    await m.handle({ request: makeRequest(), response: makeResponse(200) } as any, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled, 'request still proceeds')
    assert.lengthOf(fake.increments, 0)
    assert.lengthOf(fake.bandwidth, 0)
  })

  test('falls back to the request resolver when no tenancy context is active', async ({
    assert,
  }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, undefined)

    await m.handle(
      {
        request: makeRequest({ 'x-tenant-id': 'header-tenant' }),
        response: makeResponse(200),
      } as any,
      async () => {}
    )

    assert.equal(fake.increments[0]?.tenantId, 'header-tenant')
  })

  // SECURITY (#2/#14): a client-controlled tenant id that is not a SAFE_IDENT
  // must never reach the metric key. Otherwise a ':' in the header injects key
  // structure and forges another tenant's row in backoffice.tenant_metrics.
  test('drops a forged header carrying the ":" key delimiter instead of recording', async ({
    assert,
  }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, undefined)

    await m.handle(
      {
        request: makeRequest({ 'x-tenant-id': 'victim-uuid:2026-06-28:requests' }),
        response: makeResponse(200),
      } as any,
      async () => {}
    )

    assert.lengthOf(fake.increments, 0, 'a colon-injected tenant id must not be recorded')
    assert.lengthOf(fake.bandwidth, 0)
  })

  test('drops a non-SAFE_IDENT active context id at the attribution seam', async ({ assert }) => {
    // Even if a poisoned id somehow reached tenancy.currentId(), the seam guard
    // refuses to key on it (defense in depth, independent of the resolver).
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, 'tenant:*:injected')

    await m.handle(
      { request: makeRequest(), response: makeResponse(200, '1024') } as any,
      async () => {}
    )

    assert.lengthOf(fake.increments, 0)
    assert.lengthOf(fake.bandwidth, 0)
  })

  test('still records a clean opaque host id (no false positives)', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, undefined)

    await m.handle(
      {
        request: makeRequest({ 'x-tenant-id': 'acme-prod-01' }),
        response: makeResponse(200),
      } as any,
      async () => {}
    )

    assert.equal(fake.increments[0]?.tenantId, 'acme-prod-01')
  })

  test('short-circuits in test env unless bypassInTestEnv is false', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID, true)
    let nextCalled = false

    await m.handle({ request: makeRequest(), response: makeResponse(200) } as any, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled)
    assert.lengthOf(fake.increments, 0, 'test-env bypass must not record')
  })

  test('records in test env when bypassInTestEnv is false', async ({ assert }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID, true)

    await m.handle({ request: makeRequest(), response: makeResponse(200) } as any, async () => {}, {
      bypassInTestEnv: false,
    })

    assert.lengthOf(fake.increments, 1)
  })

  // CHAOS: a throwing metrics backend must never break the request.
  test('fail-open: a throwing increment is swallowed and the response is preserved', async ({
    assert,
  }) => {
    const fake = new FakeMetrics()
    fake.incrementImpl = () => {
      throw new Error('redis down')
    }
    const m = new TestableTrackMetrics(fake, TID)
    let nextResult: string | undefined

    const result = await m.handle(
      { request: makeRequest(), response: makeResponse(200) } as any,
      async () => {
        nextResult = 'handler-ran'
        return 'handler-ran'
      }
    )

    assert.equal(nextResult, 'handler-ran')
    assert.equal(result, 'handler-ran', 'fail-open returns the downstream result unchanged')
  })

  test('fail-open: a throwing trackBandwidth is swallowed; the request is still counted', async ({
    assert,
  }) => {
    const fake = new FakeMetrics()
    fake.bandwidthImpl = () => {
      throw new Error('redis down')
    }
    const m = new TestableTrackMetrics(fake, TID)

    await m.handle(
      { request: makeRequest(), response: makeResponse(200, '512') } as any,
      async () => {}
    )

    assert.deepEqual(
      fake.increments.map((i) => i.metric),
      ['requests']
    )
  })

  // CHAOS: a downstream throw must propagate UNCHANGED while the request is still recorded.
  test('a downstream throw propagates and the request is still recorded (finally ran)', async ({
    assert,
  }) => {
    const fake = new FakeMetrics()
    const m = new TestableTrackMetrics(fake, TID)

    await assert.rejects(
      () =>
        m.handle({ request: makeRequest(), response: makeResponse(200) } as any, async () => {
          throw new Error('boom from handler')
        }),
      'boom from handler'
    )

    assert.deepEqual(
      fake.increments.map((i) => i.metric),
      ['requests'],
      'the request was recorded in finally even though the handler threw'
    )
  })
})
