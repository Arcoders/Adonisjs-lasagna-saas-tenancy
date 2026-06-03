import { test } from '@japa/runner'
import UniversalMiddleware from '../../../src/middleware/universal_middleware.js'
import { setupTestConfig } from '../../helpers/config.js'
import { __resetResolverRegistryCacheForTests } from '../../../src/extensions/request.js'

const UUID = '11111111-1111-4111-8111-111111111111'

function makeRequest(opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v
  const memo: any = {}
  return {
    hostname: () => (headers['host'] ?? '').split(':')[0],
    url: () => (opts.url ?? '/').split('?')[0],
    header: (key: string) => headers[key.toLowerCase()] ?? null,
    qs: () => ({}),
    input: () => undefined,
    __memo: memo,
  } as any
}

test.group('UniversalMiddleware', (group) => {
  group.each.setup(() => {
    __resetResolverRegistryCacheForTests()
    setupTestConfig()
  })

  test('calls next when no tenant resolver hits', async ({ assert }) => {
    const m = new UniversalMiddleware()
    let nextCalled = false
    await m.handle({ request: makeRequest() } as any, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('calls next when resolver throws (degraded resolution should not break universal)', async ({
    assert,
  }) => {
    const m = new UniversalMiddleware()
    let nextCalled = false
    // The header IS set but the value is malformed (non-UUID) — repo lookup
    // would fail in production; here repo isn't bound, so we hit the catch
    // branch and proceed.
    await m.handle(
      { request: makeRequest({ headers: { 'x-tenant-id': 'not-a-uuid' } }) } as any,
      async () => {
        nextCalled = true
      }
    )
    assert.isTrue(nextCalled)
  })

  test('calls next when resolver returns a hit but no repository is bound', async ({ assert }) => {
    const m = new UniversalMiddleware()
    let nextCalled = false
    await m.handle(
      { request: makeRequest({ headers: { 'x-tenant-id': UUID } }) } as any,
      async () => {
        nextCalled = true
      }
    )
    assert.isTrue(nextCalled)
  })
})
