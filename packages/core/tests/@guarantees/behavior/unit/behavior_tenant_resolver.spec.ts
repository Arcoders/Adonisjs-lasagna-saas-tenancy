import { test } from '@japa/runner'
import {
  resolveTenantId,
  __resetResolverRegistryCacheForTests,
} from '../../../../src/extensions/request.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * `resolveTenantId` is the package's single chain-aware request→tenant-id
 * authority (TRES-02: the legacy `resolverStrategy` switch is gone). With no
 * registry seeded it builds the chain from config on demand, so a solitary
 * `resolverStrategy` still resolves through the REAL resolvers — including their
 * UUID border (F7: a non-UUID header/subdomain/path value falls through instead
 * of forging an id) and lowercase canonicalization (F8: a mixed-case UUID
 * collapses onto one id). Each test resets the module cache so it builds from its
 * own config rather than a chain another spec seeded.
 */

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID_UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const UUID_UPPER_CANON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeRequest(opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v
  }
  return {
    hostname: () => (headers['host'] ?? '').split(':')[0],
    url: (_full: boolean) => (opts.url ?? '/').split('?')[0],
    header: (key: string) => headers[key.toLowerCase()] ?? null,
  } as any
}

test.group('resolveTenantId — header strategy', (group) => {
  group.each.setup(() => {
    __resetResolverRegistryCacheForTests()
    setConfig({ ...testConfig, resolverStrategy: 'header' })
  })

  test('returns a canonical UUID from the configured header', ({ assert }) => {
    const req = makeRequest({ headers: { 'x-tenant-id': UUID } })
    assert.equal(resolveTenantId(req), UUID)
  })

  test('returns undefined when the header is absent', ({ assert }) => {
    assert.isUndefined(resolveTenantId(makeRequest()))
  })

  test('reads a custom header key from config', ({ assert }) => {
    __resetResolverRegistryCacheForTests()
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-workspace-id' })
    const req = makeRequest({ headers: { 'x-workspace-id': UUID } })
    assert.equal(resolveTenantId(req), UUID)
  })

  // F8: a UUID is case-insensitive, so an upper/mixed-case header collapses onto
  // ONE canonical id — one resolution-cache entry, one rate-limit bucket, one row.
  test('canonicalizes a mixed-case UUID header to lowercase', ({ assert }) => {
    const req = makeRequest({ headers: { 'x-tenant-id': UUID_UPPER } })
    assert.equal(resolveTenantId(req), UUID_UPPER_CANON)
  })

  // F7 / SECURITY (#2/#4/#14): the header is client-controlled. A value that is
  // not a canonical UUID — an opaque slug, or a string carrying the ':' Redis-key
  // delimiter — must resolve to "no tenant" (fall through) rather than flow
  // downstream into a metric/rate-limit key where it would inject structure or
  // forge another tenant's attribution.
  test('a non-UUID header falls through to no tenant', ({ assert }) => {
    for (const bad of ['tenant-abc', 'acme_prod-01', 'victim:2026-06-28:requests', 'a b', 'a"b']) {
      const req = makeRequest({ headers: { 'x-tenant-id': bad } })
      assert.isUndefined(resolveTenantId(req), `header "${bad}" must not resolve a tenant`)
    }
  })
})

test.group('resolveTenantId — subdomain strategy', (group) => {
  group.each.setup(() => {
    __resetResolverRegistryCacheForTests()
    setConfig({ ...testConfig, resolverStrategy: 'subdomain', baseDomain: 'example.com' })
  })

  test('extracts a UUID subdomain when the host ends with baseDomain', ({ assert }) => {
    const req = makeRequest({ headers: { host: `${UUID}.example.com` } })
    assert.equal(resolveTenantId(req), UUID)
  })

  test('supports baseDomain with a leading dot', ({ assert }) => {
    __resetResolverRegistryCacheForTests()
    setConfig({ ...testConfig, resolverStrategy: 'subdomain', baseDomain: '.example.com' })
    const req = makeRequest({ headers: { host: `${UUID}.example.com` } })
    assert.equal(resolveTenantId(req), UUID)
  })

  test('strips the port before extracting the subdomain', ({ assert }) => {
    const req = makeRequest({ headers: { host: `${UUID}.example.com:3333` } })
    assert.equal(resolveTenantId(req), UUID)
  })

  test('canonicalizes a mixed-case UUID subdomain to lowercase', ({ assert }) => {
    const req = makeRequest({ headers: { host: `${UUID_UPPER}.example.com` } })
    assert.equal(resolveTenantId(req), UUID_UPPER_CANON)
  })

  // F7: the label becomes a tenant id, so a non-UUID subdomain (a marketing
  // label, a typo) falls through rather than forging an id that fails downstream.
  test('a non-UUID subdomain label falls through', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'acme.example.com' } })
    assert.isUndefined(resolveTenantId(req))
  })

  test('returns undefined when the host equals baseDomain (no subdomain)', ({ assert }) => {
    assert.isUndefined(resolveTenantId(makeRequest({ headers: { host: 'example.com' } })))
  })

  test('returns undefined for a single-label host (e.g. localhost)', ({ assert }) => {
    assert.isUndefined(resolveTenantId(makeRequest({ headers: { host: 'localhost' } })))
  })
})

test.group('resolveTenantId — path strategy', (group) => {
  group.each.setup(() => {
    __resetResolverRegistryCacheForTests()
    setConfig({ ...testConfig, resolverStrategy: 'path' })
  })

  test('returns a UUID first path segment as the tenant id', ({ assert }) => {
    const req = makeRequest({ url: `/${UUID}/some/resource` })
    assert.equal(resolveTenantId(req), UUID)
  })

  test('ignores the query string when extracting the segment', ({ assert }) => {
    const req = makeRequest({ url: `/${UUID}?foo=bar` })
    assert.equal(resolveTenantId(req), UUID)
  })

  // F7: a non-UUID first segment (a route prefix, a slug) falls through.
  test('a non-UUID first segment falls through', ({ assert }) => {
    assert.isUndefined(resolveTenantId(makeRequest({ url: '/tenant-xyz/some/resource' })))
  })

  test('returns undefined for the root path', ({ assert }) => {
    assert.isUndefined(resolveTenantId(makeRequest({ url: '/' })))
  })
})
