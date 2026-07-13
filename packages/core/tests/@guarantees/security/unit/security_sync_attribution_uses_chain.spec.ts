import { test } from '@japa/runner'
import type { HttpRequest } from '@adonisjs/core/http'
import { setConfig } from '../../../../src/config.js'
import {
  resolveTenantId,
  setResolverRegistry,
  __resetResolverRegistryCacheForTests,
} from '../../../../src/extensions/request.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import { ResolverHit, type TenantResolver } from '../../../../src/services/resolvers/resolver.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * TRES-01 → TRES-02 (the one CRITICAL live bug, now closed at the root).
 * Rate-limit buckets and the `backoffice.tenant_metrics` rows once attributed the
 * tenant via a chain-BLIND `resolverStrategy` switch, while routing used the
 * resolver chain — so on ANY `resolverChain` deployment attribution landed on a
 * DIFFERENT tenant than routing served (a silent cross-tenant rate-limit bypass and
 * corrupted metering).
 *
 * TRES-02 deleted that switch: `resolveTenantId` — the one both middlewares use — IS
 * the chain-aware authority now. These specs pin that attribution follows the chain,
 * and that before the registry is seeded it BUILDS the chain from config rather than
 * falling to a divergent legacy path.
 */

const CHAIN_TENANT = '11111111-1111-4111-8111-111111111111'
const HEADER_TENANT = '22222222-2222-4222-8222-222222222222'

/** A custom resolver that always resolves to CHAIN_TENANT, regardless of request. */
const chainResolver: TenantResolver = {
  name: 'test-chain',
  contractVersion: 1,
  resolve: () => ResolverHit.id(CHAIN_TENANT),
}

/** Minimal request whose header carries a DIFFERENT (valid) tenant id. */
function requestWithHeader(value: string): HttpRequest {
  return { header: () => value } as unknown as HttpRequest
}

function seedChain(): void {
  const registry = new TenantResolverRegistry()
  registry.register(chainResolver)
  registry.setChain(['test-chain'])
  setResolverRegistry(registry)
}

test.group('TRES-02 — attribution follows the resolver chain, not the raw header', (group) => {
  group.each.teardown(() => {
    __resetResolverRegistryCacheForTests()
  })

  test('the seeded chain wins over the header the strategy switch would have read', ({
    assert,
  }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    seedChain()
    const req = requestWithHeader(HEADER_TENANT)

    // Attribution follows the tenant routing actually serves (the chain resolver),
    // not the header a chain-blind `resolverStrategy: 'header'` switch would read.
    assert.equal(resolveTenantId(req), CHAIN_TENANT)
    assert.notEqual(resolveTenantId(req), HEADER_TENANT)
  })

  test('before the registry is seeded it builds the chain from config (no legacy switch)', ({
    assert,
  }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-tenant-id' })
    __resetResolverRegistryCacheForTests() // no seed: the sync authority rebuilds from config
    const req = requestWithHeader(HEADER_TENANT)

    // A solitary `resolverStrategy: 'header'` resolves the header UUID through the
    // real HeaderResolver — the SAME code the seeded chain runs — never a divergent
    // path. HEADER_TENANT is a valid UUID, so it passes the resolver's UUID border.
    assert.equal(resolveTenantId(req), HEADER_TENANT)
  })
})
