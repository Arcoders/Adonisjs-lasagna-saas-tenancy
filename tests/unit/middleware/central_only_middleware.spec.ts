import { test } from '@japa/runner'
import CentralOnlyMiddleware from '../../../src/middleware/central_only_middleware.js'
import CentralRouteViolationException from '../../../src/exceptions/central_route_violation_exception.js'
import { setupTestConfig } from '../../helpers/config.js'
import { __resetResolverRegistryCacheForTests } from '../../../src/extensions/request.js'

const UUID = '11111111-1111-4111-8111-111111111111'

function makeRequest(opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v
  return {
    hostname: () => (headers['host'] ?? '').split(':')[0],
    url: () => (opts.url ?? '/').split('?')[0],
    header: (key: string) => headers[key.toLowerCase()] ?? null,
    qs: () => ({}),
    input: () => undefined,
  } as any
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

test.group('CentralOnlyMiddleware', (group) => {
  group.each.setup(() => {
    __resetResolverRegistryCacheForTests()
    setupTestConfig()
  })

  test('passes through when no tenant resolves', async ({ assert }) => {
    const m = new CentralOnlyMiddleware()
    let nextCalled = false
    await m.handle({ request: makeRequest() } as any, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('throws CentralRouteViolationException when a tenant id is resolved', async ({ assert }) => {
    const m = new CentralOnlyMiddleware()
    const err = await catchError(() =>
      m.handle({ request: makeRequest({ headers: { 'x-tenant-id': UUID } }) } as any, async () => {})
    )
    assert.instanceOf(err, CentralRouteViolationException)
  })

  test('throws when subdomain resolves a tenant', async ({ assert }) => {
    setupTestConfig({ resolverStrategy: 'subdomain', baseDomain: 'example.com' })
    const m = new CentralOnlyMiddleware()
    const err = await catchError(() =>
      m.handle(
        { request: makeRequest({ headers: { host: 'acme.example.com' } }) } as any,
        async () => {}
      )
    )
    assert.instanceOf(err, CentralRouteViolationException)
  })
})
