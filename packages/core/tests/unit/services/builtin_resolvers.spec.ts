import { test } from '@japa/runner'
import {
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
} from '../../../src/services/resolvers/builtins.js'
import InvalidTenantIdentifierException from '../../../src/exceptions/invalid_tenant_identifier_exception.js'
import { setupTestConfig } from '../../helpers/config.js'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'

function makeRequest(
  opts: {
    headers?: Record<string, string>
    url?: string
    qs?: Record<string, string>
    body?: Record<string, unknown>
  } = {}
) {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v
  }
  return {
    hostname: () => (headers['host'] ?? '').split(':')[0],
    url: () => (opts.url ?? '/').split('?')[0],
    header: (key: string) => headers[key.toLowerCase()] ?? null,
    qs: () => opts.qs ?? {},
    input: (key: string) => opts.body?.[key],
  } as any
}

test.group('HeaderResolver', (group) => {
  group.each.setup(() => setupTestConfig())

  test('returns id from the configured header', ({ assert }) => {
    const r = new HeaderResolver()
    const result = r.resolve(makeRequest({ headers: { 'x-tenant-id': UUID } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })

  test('returns miss when the header is absent', ({ assert }) => {
    const r = new HeaderResolver()
    assert.isUndefined(r.resolve(makeRequest({})))
  })

  test('honors a custom tenantHeaderKey', ({ assert }) => {
    setupTestConfig({ tenantHeaderKey: 'x-workspace' })
    const r = new HeaderResolver()
    const result = r.resolve(makeRequest({ headers: { 'x-workspace': UUID } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })
})

test.group('SubdomainResolver', (group) => {
  group.each.setup(() => setupTestConfig({ baseDomain: 'example.com' }))

  test('extracts the subdomain when host ends with baseDomain', ({ assert }) => {
    const r = new SubdomainResolver()
    const result = r.resolve(makeRequest({ headers: { host: `acme.example.com` } }))
    assert.deepEqual(result, { type: 'id', tenantId: 'acme' })
  })

  test('returns miss for the bare base domain (apex)', ({ assert }) => {
    const r = new SubdomainResolver()
    assert.isUndefined(r.resolve(makeRequest({ headers: { host: 'example.com' } })))
  })

  test('falls back to leftmost label when host does not end with baseDomain (dev only)', ({
    assert,
  }) => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const r = new SubdomainResolver()
      const result = r.resolve(makeRequest({ headers: { host: 'acme.test.local' } }))
      assert.deepEqual(result, { type: 'id', tenantId: 'acme' })
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  test('refuses the off-baseDomain leftmost-label fallback in production', ({ assert }) => {
    const prev = process.env.NODE_ENV
    try {
      // Both spellings AdonisJS normalizes to production must close the gate.
      for (const env of ['production', 'prod']) {
        process.env.NODE_ENV = env
        const r = new SubdomainResolver()
        assert.isUndefined(
          r.resolve(makeRequest({ headers: { host: 'acme.test.local' } })),
          `NODE_ENV=${env} must refuse the fallback`
        )
      }
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  test('returns miss when host has no labels (single hostname)', ({ assert }) => {
    const r = new SubdomainResolver()
    assert.isUndefined(r.resolve(makeRequest({ headers: { host: 'localhost' } })))
  })

  test('with expectedHostSuffix set, an allowlisted host still resolves', ({ assert }) => {
    setupTestConfig({ baseDomain: 'example.com', resolver: { expectedHostSuffix: 'example.com' } })
    const r = new SubdomainResolver()
    assert.deepEqual(r.resolve(makeRequest({ headers: { host: 'acme.example.com' } })), {
      type: 'id',
      tenantId: 'acme',
    })
  })

  test('with expectedHostSuffix set, an off-allowlist host is refused (no label extraction)', ({
    assert,
  }) => {
    // A spoofed X-Forwarded-Host ending in a baseDomain that is NOT on the
    // allowlist must not resolve a tenant.
    setupTestConfig({
      baseDomain: 'example.com',
      resolver: { expectedHostSuffix: 'app.example.com' },
    })
    const r = new SubdomainResolver()
    assert.isUndefined(r.resolve(makeRequest({ headers: { host: 'victim.example.com' } })))
  })
})

test.group('PathResolver', (group) => {
  group.each.setup(() => setupTestConfig({ ignorePaths: ['/health', '/admin', '/api/webhooks'] }))

  test('extracts the first segment of the path', ({ assert }) => {
    const r = new PathResolver()
    const result = r.resolve(makeRequest({ url: `/${UUID}/orders` }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })

  test('returns miss for ignored path prefixes', ({ assert }) => {
    const r = new PathResolver()
    assert.isUndefined(r.resolve(makeRequest({ url: '/health' })))
    assert.isUndefined(r.resolve(makeRequest({ url: '/admin/tenants' })))
  })

  test('returns miss for the root path', ({ assert }) => {
    const r = new PathResolver()
    assert.isUndefined(r.resolve(makeRequest({ url: '/' })))
  })
})

test.group('DomainOrSubdomainResolver', (group) => {
  group.each.setup(() => setupTestConfig({ baseDomain: 'app.test' }))

  test('returns subdomain when host is *.baseDomain', ({ assert }) => {
    const r = new DomainOrSubdomainResolver()
    const result = r.resolve(makeRequest({ headers: { host: 'acme.app.test' } }))
    assert.deepEqual(result, { type: 'id', tenantId: 'acme' })
  })

  test('returns a {domain} envelope for a non-baseDomain host', ({ assert }) => {
    const r = new DomainOrSubdomainResolver()
    const result = r.resolve(makeRequest({ headers: { host: 'acme.com' } }))
    assert.deepEqual(result, { type: 'domain', domain: 'acme.com' })
  })

  test('returns miss for the apex host itself', ({ assert }) => {
    const r = new DomainOrSubdomainResolver()
    assert.isUndefined(r.resolve(makeRequest({ headers: { host: 'app.test' } })))
  })

  test('with expectedHostSuffix set, an off-allowlist host yields no domain envelope', ({
    assert,
  }) => {
    // RED before the gate: this returned { type: 'domain', domain: 'evil.com' },
    // which the registry would have looked up via findByDomain.
    setupTestConfig({ baseDomain: 'app.test', resolver: { expectedHostSuffix: 'app.test' } })
    const r = new DomainOrSubdomainResolver()
    assert.isUndefined(r.resolve(makeRequest({ headers: { host: 'evil.com' } })))
  })

  test('with expectedHostSuffix listing a custom domain, that host still yields an envelope', ({
    assert,
  }) => {
    setupTestConfig({
      baseDomain: 'app.test',
      resolver: { expectedHostSuffix: ['app.test', 'acme.com'] },
    })
    const r = new DomainOrSubdomainResolver()
    assert.deepEqual(r.resolve(makeRequest({ headers: { host: 'acme.com' } })), {
      type: 'domain',
      domain: 'acme.com',
    })
  })
})

test.group('RequestDataResolver', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reads the tenant id from the query string', ({ assert }) => {
    const r = new RequestDataResolver()
    const result = r.resolve(makeRequest({ qs: { tenant_id: UUID } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })

  test('falls back to the request body when the query is empty', ({ assert }) => {
    const r = new RequestDataResolver()
    const result = r.resolve(makeRequest({ body: { tenant_id: UUID } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })

  test('honors custom queryKey/bodyKey from config', ({ assert }) => {
    setupTestConfig({ requestData: { queryKey: 'workspace', bodyKey: 'workspaceId' } })
    const r = new RequestDataResolver()
    const fromQs = r.resolve(makeRequest({ qs: { workspace: UUID } }))
    assert.deepEqual(fromQs, { type: 'id', tenantId: UUID })
    const fromBody = r.resolve(makeRequest({ body: { workspaceId: UUID } }))
    assert.deepEqual(fromBody, { type: 'id', tenantId: UUID })
  })

  test('returns miss when neither source has the key', ({ assert }) => {
    const r = new RequestDataResolver()
    assert.isUndefined(r.resolve(makeRequest({})))
  })

  test('throws a 400 when the query value is present but not a string (array)', ({ assert }) => {
    const r = new RequestDataResolver()
    assert.throws(
      () => r.resolve(makeRequest({ qs: { tenant_id: [UUID, UUID2] as any } })),
      InvalidTenantIdentifierException.message
    )
  })

  test('throws a 400 when the body value is present but not a string (object)', ({ assert }) => {
    const r = new RequestDataResolver()
    assert.throws(
      () => r.resolve(makeRequest({ body: { tenant_id: { nested: UUID } as any } })),
      InvalidTenantIdentifierException.message
    )
  })

  test('misses on a present-but-malformed (non-UUID) string so the chain can fall through', ({
    assert,
  }) => {
    const r = new RequestDataResolver()
    assert.isUndefined(r.resolve(makeRequest({ qs: { tenant_id: 'not-a-uuid' } })))
  })

  test('honors sourceOrder: body wins over query when configured first', ({ assert }) => {
    setupTestConfig({ requestData: { sourceOrder: ['body', 'query'] } })
    const r = new RequestDataResolver()
    const result = r.resolve(makeRequest({ qs: { tenant_id: UUID }, body: { tenant_id: UUID2 } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID2 })
  })

  test('default sourceOrder keeps query ahead of body', ({ assert }) => {
    const r = new RequestDataResolver()
    const result = r.resolve(makeRequest({ qs: { tenant_id: UUID }, body: { tenant_id: UUID2 } }))
    assert.deepEqual(result, { type: 'id', tenantId: UUID })
  })
})
