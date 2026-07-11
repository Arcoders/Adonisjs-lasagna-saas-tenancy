import { test } from '@japa/runner'
import { resolveTenantId, setConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * The subdomain / path resolution strategies are awkward to drive end-to-end
 * because the test HTTP client's Host header and path are both fixed. We
 * test the resolver primitive directly with a fabricated `HttpRequest`-like
 * object. `resolveTenantId` only reads `hostname()`, `url()`, and
 * `header()`, so this is enough to exercise every code path.
 */
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
  let originalConfig: any
  group.setup(async () => {
    originalConfig = (await import('#config/multitenancy')).default
  })
  group.teardown(() => {
    setConfig(originalConfig)
  })

  test('header strategy reads from configured tenantHeaderKey', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const req = fakeRequest({ headers: { 'x-tenant-id': tenantId } })
    assert.equal(resolveTenantId(req), tenantId)
  })

  test('header strategy returns undefined when the header is missing', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    assert.isUndefined(resolveTenantId(fakeRequest({})))
  })

  test('header strategy honours a custom header name', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-org' })
    const id = '22222222-2222-4222-8222-222222222222'
    const req = fakeRequest({ headers: { 'x-org': id } })
    assert.equal(resolveTenantId(req), id)
  })

  test('subdomain strategy extracts the first label below baseDomain', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    const req = fakeRequest({ hostname: 'acme.example.test' })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('subdomain strategy strips the port from hostname', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    const req = fakeRequest({ hostname: 'acme.example.test:3333' })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('subdomain strategy returns undefined for the apex domain', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    const req = fakeRequest({ hostname: 'example.test' })
    assert.isUndefined(resolveTenantId(req))
  })

  test('subdomain strategy still works with leading-dot baseDomain', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: '.example.test' })
    const req = fakeRequest({ hostname: 'beta.example.test' })
    assert.equal(resolveTenantId(req), 'beta')
  })

  test('subdomain strategy falls back to the first label when host has unexpected suffix', ({
    assert,
  }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'subdomain', baseDomain: 'example.test' })
    const req = fakeRequest({ hostname: 'acme.other.tld' })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('path strategy extracts the first URL segment', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    const req = fakeRequest({ url: '/acme/things' })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('path strategy ignores leading slashes', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    const req = fakeRequest({ url: '/acme' })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('path strategy returns undefined for an empty URL', ({ assert }) => {
    setConfig({ ...originalConfig, resolverStrategy: 'path' })
    assert.isUndefined(resolveTenantId(fakeRequest({ url: '/' })))
  })
})
