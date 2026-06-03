import { test } from '@japa/runner'
import { resolveTenantId } from '../../../src/extensions/request.js'
import { setConfig } from '../../../src/config.js'
import { testConfig } from '../../helpers/config.js'

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
  group.each.setup(() => setConfig({ ...testConfig, resolverStrategy: 'header' }))

  test('returns tenant id from configured header', ({ assert }) => {
    const req = makeRequest({ headers: { 'x-tenant-id': 'tenant-abc' } })
    assert.equal(resolveTenantId(req), 'tenant-abc')
  })

  test('returns undefined when header is absent', ({ assert }) => {
    const req = makeRequest()
    assert.isUndefined(resolveTenantId(req))
  })

  test('reads custom header key from config', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-workspace-id' })
    const req = makeRequest({ headers: { 'x-workspace-id': 'workspace-123' } })
    assert.equal(resolveTenantId(req), 'workspace-123')
  })
})

test.group('resolveTenantId — subdomain strategy', (group) => {
  group.each.setup(() =>
    setConfig({ ...testConfig, resolverStrategy: 'subdomain', baseDomain: 'example.com' })
  )

  test('extracts subdomain when host ends with baseDomain', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'acme.example.com' } })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('supports baseDomain with leading dot', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'subdomain', baseDomain: '.example.com' })
    const req = makeRequest({ headers: { host: 'acme.example.com' } })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('strips port from host before extracting subdomain', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'acme.example.com:3333' } })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('returns undefined when host equals baseDomain (no subdomain)', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'example.com' } })
    assert.isUndefined(resolveTenantId(req))
  })

  test('falls back to first label when host does not match baseDomain', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'acme.other.com' } })
    assert.equal(resolveTenantId(req), 'acme')
  })

  test('returns undefined for single-label host (e.g. localhost)', ({ assert }) => {
    const req = makeRequest({ headers: { host: 'localhost' } })
    assert.isUndefined(resolveTenantId(req))
  })
})

test.group('resolveTenantId — path strategy', (group) => {
  group.each.setup(() => setConfig({ ...testConfig, resolverStrategy: 'path' }))

  test('returns first path segment as tenant id', ({ assert }) => {
    const req = makeRequest({ url: '/tenant-xyz/some/resource' })
    assert.equal(resolveTenantId(req), 'tenant-xyz')
  })

  test('returns first segment for a single-segment path', ({ assert }) => {
    const req = makeRequest({ url: '/tenant-xyz' })
    assert.equal(resolveTenantId(req), 'tenant-xyz')
  })

  test('returns undefined for root path', ({ assert }) => {
    const req = makeRequest({ url: '/' })
    assert.isUndefined(resolveTenantId(req))
  })

  test('ignores query string when extracting segment', ({ assert }) => {
    const req = makeRequest({ url: '/tenant-xyz?foo=bar' })
    assert.equal(resolveTenantId(req), 'tenant-xyz')
  })
})
