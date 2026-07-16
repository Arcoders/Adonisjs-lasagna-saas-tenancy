import { test } from '@japa/runner'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import {
  ResolverHit,
  SyncTenantResolver,
  type ResolverTrust,
  type TenantResolveResult,
  type TenantResolver,
} from '../../../../src/services/resolvers/resolver.js'
import { builtInResolvers } from '../../../../src/services/resolvers/builtins.js'
import { chainTrusts, entryTrust } from '../../../../src/services/resolvers/resolver_trust.js'
import { membershipGateRisk } from '../../../../src/services/membership_gate.js'
import {
  hostTrustWarning,
  resolutionUsesHostStrategy,
} from '../../../../src/providers/assert_host_trust.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * TRES-04 / F4 + TRES-06.
 *
 * TRES-04 replaces the two hand-kept name sets (CLIENT_CONTROLLED, HOST_STRATEGIES)
 * with a single `trust` field each resolver declares, and (F4) makes an
 * unclassified resolver fail SAFE to client-controlled so a bespoke resolver can
 * no longer silently disable the IDOR hard-fail. TRES-06 makes synchronous
 * resolution an explicit contract member (`resolveSync`) instead of Promise
 * sniffing, and fails closed when an async-only resolver is placed in the routing
 * chain (the split-brain: request.tenant() resolves a tenant the sync path skips).
 */

const UUID = '11111111-1111-4111-8111-111111111111'
const cfg = (o: Partial<MultitenancyConfig>) => ({ ...testConfig, ...o }) as MultitenancyConfig

test.group('TRES-04 — resolver trust classification', (group) => {
  group.each.setup(() => setConfig({ ...testConfig }))

  test('every built-in declares a trust in {host, client, server}', ({ assert }) => {
    for (const r of builtInResolvers) {
      assert.oneOf(r.trust, ['host', 'client', 'server'], `${r.name} must declare a trust`)
    }
  })

  test('an inline resolver with no declared trust fails safe to client-controlled', ({
    assert,
  }) => {
    const custom: TenantResolver = {
      name: 'x',
      resolve: () => ResolverHit.miss(),
      resolveSync: () => ResolverHit.miss(),
    }
    assert.equal(entryTrust(cfg({}), custom), 'client')
    // No trust + no gate + no acknowledgement => the IDOR nudge fires.
    assert.isNotNull(membershipGateRisk(cfg({ resolverChain: [custom] })))
  })

  test('trust:server opts a custom resolver out of the IDOR nudge', ({ assert }) => {
    const server: TenantResolver = {
      name: 'sess',
      trust: 'server',
      resolve: () => ResolverHit.id(UUID),
      resolveSync: () => ResolverHit.id(UUID),
    }
    assert.equal(entryTrust(cfg({}), server), 'server')
    assert.isNull(membershipGateRisk(cfg({ resolverChain: [server] })))
  })

  test('trust:host makes the host-trust audit fire without an allowlist', ({ assert }) => {
    const hostR: TenantResolver = {
      name: 'h',
      trust: 'host',
      resolve: () => ResolverHit.miss(),
      resolveSync: () => ResolverHit.miss(),
    }
    assert.isTrue(resolutionUsesHostStrategy(cfg({ resolverChain: [hostR] })))
    assert.isNotNull(hostTrustWarning(cfg({ resolverChain: [hostR] })))
  })

  test('chainTrusts classifies the whole chain from the built-in trust', ({ assert }) => {
    assert.deepEqual(chainTrusts(cfg({ resolverChain: ['subdomain', 'header'] })), [
      'host',
      'client',
    ])
  })

  test('an inline instance reusing a built-in host name is classified by the built-in that runs', ({
    assert,
  }) => {
    // wireResolverChain registers built-ins first, so a same-named instance is
    // dropped and the host-based built-in actually runs. The audit must classify
    // by that built-in ('host'), not the trust-less instance ('client'), or a
    // host-based resolver would escape the host-trust hard-fail.
    const shadow: TenantResolver = {
      name: 'subdomain',
      resolve: () => ResolverHit.miss(),
      resolveSync: () => ResolverHit.miss(),
    }
    assert.equal(entryTrust(cfg({}), shadow), 'host')
    assert.isTrue(resolutionUsesHostStrategy(cfg({ resolverChain: [shadow] })))
    assert.isNotNull(hostTrustWarning(cfg({ resolverChain: [shadow] })))
  })
})

test.group('TRES-06 — synchronous resolver contract', (group) => {
  group.each.setup(() => setConfig({ ...testConfig }))

  test('setChain refuses an async-only resolver (no resolveSync), naming it', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register({ name: 'async-only', resolve: async () => ResolverHit.id(UUID) })
    assert.throws(() => reg.setChain(['async-only']), /async-only/)
  })

  test('resolveSync calls the resolver resolveSync, never resolve', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    let syncCalls = 0
    let asyncCalls = 0
    reg.register({
      name: 's',
      resolve: () => {
        asyncCalls++
        return ResolverHit.miss()
      },
      resolveSync: () => {
        syncCalls++
        return ResolverHit.id(UUID)
      },
    })
    reg.setChain(['s'])
    assert.deepEqual(reg.resolveSync({} as never), { type: 'id', tenantId: UUID })
    assert.equal(syncCalls, 1)
    assert.equal(asyncCalls, 0)
  })

  test('SyncTenantResolver: resolve forwards to resolveSync and carries the contract version', ({
    assert,
  }) => {
    class R extends SyncTenantResolver {
      readonly name = 'r'
      readonly trust: ResolverTrust = 'server'
      resolveSync(): TenantResolveResult {
        return ResolverHit.id(UUID)
      }
    }
    const r = new R()
    assert.deepEqual(r.resolve({} as never), { type: 'id', tenantId: UUID })
    assert.equal(r.contractVersion, 2)
  })
})
