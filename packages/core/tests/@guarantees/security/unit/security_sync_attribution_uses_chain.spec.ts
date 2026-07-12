import { test } from '@japa/runner'
import type { HttpRequest } from '@adonisjs/core/http'
import { setConfig } from '../../../../src/config.js'
import {
  resolveTenantId,
  resolveTenantIdSync,
  setResolverRegistry,
  __resetResolverRegistryCacheForTests,
} from '../../../../src/extensions/request.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import { ResolverHit, type TenantResolver } from '../../../../src/services/resolvers/resolver.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * TRES-01 (the one CRITICAL live bug). Rate-limit buckets and the
 * `backoffice.tenant_metrics` rows used to attribute the tenant via the public
 * `resolveTenantId` — the v1 strategy switch, which reads `resolverStrategy`
 * ALONE and never consults the resolver chain. On ANY `resolverChain` deployment
 * that attributes to a DIFFERENT tenant than routing serves: a silent cross-tenant
 * rate-limit bypass and corrupted metering.
 *
 * The fix is one chain-aware `resolveTenantIdSync` (seeded from boot) that both
 * middlewares now use, so attribution follows the SAME authority as routing. These
 * specs pin the divergence: the chain-aware resolver and the legacy switch
 * disagree, and the sync path must follow the chain.
 */

const CHAIN_TENANT = '11111111-1111-4111-8111-111111111111'
const HEADER_TENANT = '22222222-2222-4222-8222-222222222222'

/** A custom resolver that always resolves to CHAIN_TENANT, regardless of request. */
const chainResolver: TenantResolver = {
  name: 'test-chain',
  contractVersion: 1,
  resolve: () => ResolverHit.id(CHAIN_TENANT),
}

/** Minimal request whose header carries a DIFFERENT (safe) tenant id. */
function requestWithHeader(value: string): HttpRequest {
  return { header: () => value } as unknown as HttpRequest
}

function seedChain(): void {
  const registry = new TenantResolverRegistry()
  registry.register(chainResolver)
  registry.setChain(['test-chain'])
  setResolverRegistry(registry)
}

test.group('TRES-01 — sync attribution follows the chain, not the legacy switch', (group) => {
  group.each.teardown(() => {
    __resetResolverRegistryCacheForTests()
  })

  test('resolveTenantIdSync returns the CHAIN id while the legacy resolveTenantId returns the header id', ({
    assert,
  }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    seedChain()
    const req = requestWithHeader(HEADER_TENANT)

    // The fix: attribution follows the tenant routing actually serves.
    assert.equal(resolveTenantIdSync(req), CHAIN_TENANT)
    // The bug it closes: the chain-blind switch attributes to a DIFFERENT tenant.
    assert.equal(resolveTenantId(req), HEADER_TENANT)
    assert.notEqual(resolveTenantIdSync(req), resolveTenantId(req))
  })

  test('legacyAdapterFallback opts the sync path back to the strategy switch', ({ assert }) => {
    setConfig({
      ...testConfig,
      resolverStrategy: 'header',
      tenantHeaderKey: 'x-tenant-id',
      resolver: { legacyAdapterFallback: true },
    })
    seedChain()
    const req = requestWithHeader(HEADER_TENANT)

    // With the documented opt-out, the sync path matches the adapter's own opt-out.
    assert.equal(resolveTenantIdSync(req), HEADER_TENANT)
  })

  test('before the registry is seeded (pre-boot / unbooted unit test) it falls back to the switch', ({
    assert,
  }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    __resetResolverRegistryCacheForTests() // no seed
    const req = requestWithHeader(HEADER_TENANT)

    assert.equal(resolveTenantIdSync(req), HEADER_TENANT)
  })
})
