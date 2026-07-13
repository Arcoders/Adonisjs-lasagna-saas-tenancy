import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { resolveTenantId, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { TenantResolverRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * The subdomain / path resolution strategies are awkward to drive end-to-end
 * because the test HTTP client's Host header and path are both fixed. We test
 * the public `resolveTenantId` primitive directly with a fabricated
 * `HttpRequest`-like object. `resolveTenantId` walks the boot-seeded resolver
 * chain, so each test also points that chain at the strategy under test (and the
 * teardown restores it), mirroring the wiring the provider applies at boot.
 *
 * Tenant ids are canonical UUID v4: the resolver border only mints an id for a
 * UUID (a non-UUID header/subdomain/path value falls through), and a mixed-case
 * UUID is canonicalized to lowercase.
 */
const TENANT = '11111111-1111-4111-8111-111111111111'
const TENANT2 = '22222222-2222-4222-8222-222222222222'

function fakeRequest(parts: {
  hostname?: string
  url?: string
  headers?: Record<string, string>
}): any {
  return {
    hostname: () => parts.hostname ?? 'localhost',
    url: (_includeQuery?: boolean) => parts.url ?? '/',
    header: (key: string) => parts.headers?.[key.toLowerCase()],
  }
}

test.group('e2e — tenant resolution strategies', (group) => {
  let registry: TenantResolverRegistry
  let originalConfig: any
  let originalChain: string[]

  group.setup(async () => {
    registry = await app.container.make(TenantResolverRegistry)
    originalConfig = (await import('#config/multitenancy')).default
    originalChain = [...registry.chain()]
  })
  group.teardown(() => {
    setConfig(originalConfig)
    registry.setChain(originalChain)
  })

  test('header strategy reads a UUID from the configured tenantHeaderKey', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    registry.setChain(['header'])
    const req = fakeRequest({ headers: { 'x-tenant-id': TENANT } })
    assert.equal(resolveTenantId(req), TENANT)
  })

  test('header strategy returns undefined when the header is missing', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    registry.setChain(['header'])
    assert.isUndefined(resolveTenantId(fakeRequest({})))
  })

  test('header strategy honours a custom header name', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-org' })
    registry.setChain(['header'])
    const req = fakeRequest({ headers: { 'x-org': TENANT2 } })
    assert.equal(resolveTenantId(req), TENANT2)
  })

  test('header strategy canonicalizes a mixed-case UUID to lowercase', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    registry.setChain(['header'])
    const req = fakeRequest({ headers: { 'x-tenant-id': 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } })
    assert.equal(resolveTenantId(req), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  test('header strategy falls through on a non-UUID value', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    registry.setChain(['header'])
    assert.isUndefined(resolveTenantId(fakeRequest({ headers: { 'x-tenant-id': 'acme' } })))
  })

  test('subdomain strategy extracts a UUID label below baseDomain', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    registry.setChain(['subdomain'])
    const req = fakeRequest({ hostname: `${TENANT}.example.test` })
    assert.equal(resolveTenantId(req), TENANT)
  })

  test('subdomain strategy strips the port from hostname', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    registry.setChain(['subdomain'])
    const req = fakeRequest({ hostname: `${TENANT}.example.test:3333` })
    assert.equal(resolveTenantId(req), TENANT)
  })

  test('subdomain strategy returns undefined for the apex domain', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    registry.setChain(['subdomain'])
    const req = fakeRequest({ hostname: 'example.test' })
    assert.isUndefined(resolveTenantId(req))
  })

  test('subdomain strategy falls through on a non-UUID label', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    registry.setChain(['subdomain'])
    assert.isUndefined(resolveTenantId(fakeRequest({ hostname: 'acme.example.test' })))
  })

  test('path strategy extracts a UUID first URL segment', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    registry.setChain(['path'])
    const req = fakeRequest({ url: `/${TENANT}/things` })
    assert.equal(resolveTenantId(req), TENANT)
  })

  test('path strategy falls through on a non-UUID segment', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    registry.setChain(['path'])
    assert.isUndefined(resolveTenantId(fakeRequest({ url: '/acme/things' })))
  })

  test('path strategy returns undefined for an empty URL', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    registry.setChain(['path'])
    assert.isUndefined(resolveTenantId(fakeRequest({ url: '/' })))
  })
})
