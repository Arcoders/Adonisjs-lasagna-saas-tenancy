import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { TenantResolverRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * HARDENING: forwarded-host tenant hop.
 *
 * A host-based resolver (subdomain / domain-or-subdomain) derives the tenant
 * from the request host. Under a permissive proxy trust the host can be set via
 * X-Forwarded-Host, so without an allowlist a request can be steered onto
 * another tenant's host. The `resolver.expectedHostSuffix` allowlist refuses a
 * host outside the configured suffix(es) BEFORE any tenant extraction or
 * findByDomain lookup. This drives the real package build (the demo
 * self-references it) through the resolver registry.
 *
 * The test HTTP client fixes Host/path, so we exercise the resolution primitive
 * with a fabricated request (the established pattern in resolution_strategies),
 * but through the booted registry so the assertion covers the wired chain.
 */
function fakeRequest(host: string): any {
  return {
    hostname: () => host,
    url: (_q?: boolean) => '/',
    header: (_k: string) => undefined,
    qs: () => ({}),
    input: (_k: string) => undefined,
  }
}

test.group('hardening — forwarded-host tenant hop', (group) => {
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

  test('subdomain: an allowlisted host resolves, a spoofed off-allowlist host does not', async ({
    assert,
  }) => {
    setConfig({
      ...originalConfig,
      resolverStrategy: 'subdomain',
      baseDomain: 'tenants.example',
      resolver: { ...originalConfig.resolver, expectedHostSuffix: 'tenants.example' },
    })
    registry.setChain(['subdomain'])

    const allowed = await registry.resolve(fakeRequest('acme.tenants.example'))
    assert.deepEqual(allowed, { type: 'id', tenantId: 'acme' })

    // Spoofed X-Forwarded-Host pointing at a different apex must not resolve.
    const spoofed = await registry.resolve(fakeRequest('victim.evil.example'))
    assert.isUndefined(spoofed)
  })

  test('domain-or-subdomain: an off-allowlist host yields no findByDomain envelope', async ({
    assert,
  }) => {
    setConfig({
      ...originalConfig,
      resolverStrategy: 'domain-or-subdomain',
      baseDomain: 'tenants.example',
      resolver: { ...originalConfig.resolver, expectedHostSuffix: ['tenants.example'] },
    })
    registry.setChain(['domain-or-subdomain'])

    // Off-allowlist host: no domain envelope, so the registry never calls
    // findByDomain with an attacker-chosen host.
    assert.isUndefined(await registry.resolve(fakeRequest('victim-custom-domain.com')))
  })
})
