import { test } from '@japa/runner'
import CrossDomainRedirectService from '../../../src/services/cross_domain_redirect_service.js'
import { setupTestConfig } from '../../helpers/config.js'

function fakeTenant(overrides: { id?: string; customDomain?: string | null } = {}): any {
  return {
    id: overrides.id ?? 'acme',
    customDomain: overrides.customDomain ?? null,
  }
}

test.group('CrossDomainRedirectService', (group) => {
  group.each.setup(() => setupTestConfig({ baseDomain: 'example.com' }))

  test('toTenant builds https URL on the tenant subdomain', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const url = svc.toTenant(fakeTenant({ id: 'acme' }), '/dashboard')
    assert.equal(url, 'https://acme.example.com/dashboard')
  })

  test('toTenant prefers customDomain over subdomain when present', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const url = svc.toTenant(fakeTenant({ customDomain: 'app.acme.test' }), '/x')
    assert.equal(url, 'https://app.acme.test/x')
  })

  test('toTenant prepends a leading slash if missing', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    assert.equal(
      svc.toTenant(fakeTenant({ id: 'a' }), 'profile'),
      'https://a.example.com/profile'
    )
  })

  test('toCentral builds URL on the apex / base domain', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    assert.equal(svc.toCentral('/login'), 'https://example.com/login')
  })

  test('toTenantSubdomain builds URL from a slug without a model', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    assert.equal(svc.toTenantSubdomain('acme', '/x'), 'https://acme.example.com/x')
  })

  test('honors port and protocol overrides', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    assert.equal(
      svc.toTenant(fakeTenant({ id: 'a' }), '/x', { protocol: 'http', port: 3333 }),
      'http://a.example.com:3333/x'
    )
  })

  test('fromRequest mirrors the source request protocol', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const req: any = {
      protocol: () => 'http',
      parsedUrl: { query: '' },
    }
    assert.equal(
      svc.fromRequest(req, { tenant: fakeTenant({ id: 'a' }), path: '/x' }),
      'http://a.example.com/x'
    )
  })

  test('fromRequest preserves the source query when preserveQuery is true', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const req: any = {
      protocol: () => 'https',
      parsedUrl: { query: 'foo=bar&baz=1' },
    }
    assert.equal(
      svc.fromRequest(
        req,
        { tenant: fakeTenant({ id: 'a' }), path: '/x' },
        { preserveQuery: true }
      ),
      'https://a.example.com/x?foo=bar&baz=1'
    )
  })

  test('fromRequest merges query when path already has one', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const req: any = {
      protocol: () => 'https',
      parsedUrl: { query: 'k=v' },
    }
    assert.equal(
      svc.fromRequest(
        req,
        { tenant: fakeTenant({ id: 'a' }), path: '/x?a=1' },
        { preserveQuery: true }
      ),
      'https://a.example.com/x?a=1&k=v'
    )
  })

  test('fromRequest with central target builds central URL', ({ assert }) => {
    const svc = new CrossDomainRedirectService()
    const req: any = {
      protocol: () => 'https',
      parsedUrl: { query: '' },
    }
    assert.equal(
      svc.fromRequest(req, { central: true, path: '/login' }),
      'https://example.com/login'
    )
  })
})
