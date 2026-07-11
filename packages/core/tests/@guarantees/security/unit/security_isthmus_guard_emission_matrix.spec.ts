import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  emitIsthmusEvent,
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __resetIsthmusRateLimit,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'
import { ISTHMUS_REGISTRY, type IsthmusGuardId } from '../../../../src/isthmus/registry.js'
import { assertSafeIdentifier } from '../../../../src/services/isolation/identifier.js'
import CrossDomainRedirectService from '../../../../src/services/cross_domain_redirect_service.js'
import { assertConfigBounds } from '../../../../src/providers/assert_config_bounds.js'
import { assertResolverChain } from '../../../../src/providers/resolver_chain.js'
import { assertMetricValue } from '../../../../src/services/metrics_validation.js'
import { assertMetricsGuarded } from '../../../../src/health/assert_metrics_guarded.js'
import { setTenantRlsGuc, type RlsQueryRunner } from '../../../../src/services/isolation/rls.js'
import { tenantChannel } from '../../../../src/services/bootstrappers/transmit_bootstrapper.js'
import { safeFetch } from '../../../../src/utils/safe_fetch.js'
import WebhookService from '../../../../src/services/webhook_service.js'
import { withTenantScope } from '../../../../src/models/scoping.js'
import CapabilityRegistry from '../../../../src/services/capability_registry.js'
import { assertCoreAccessAllowed } from '../../../../src/services/plugin_core_access.js'
import { pluginScope } from '../../../../src/services/plugin_execution_scope.js'
import { capabilityKey, pluginName } from '../../../../src/sdk/brands.js'
import { tenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import BootstrapperRegistry from '../../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'
import type { IsthmusGuardTrippedPayload, IsthmusPillar } from '../../../../src/types/isthmus.js'

/**
 * The registry-driven guard emission matrix. Every registered non-audit guard
 * must, when tripped, emit its own event (exactly once) with a payload that
 * mirrors its registry entry, and must NOT emit on a happy input. Completeness
 * is pinned BOTH ways so a new guard cannot ship without a behavioral test:
 * every non-audit id has a matrix entry (or a named integration spec that
 * actually asserts the emission), and every matrix key is a real registry id.
 */

const UUID = '11111111-1111-4111-8111-111111111111'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function recordingRunner(): RlsQueryRunner {
  return { async rawQuery() {} }
}

function makeScopedModel() {
  const hooks: Record<string, Array<(...a: any[]) => any>> = {}
  class FakeBaseModel {
    static booted = false
    static boot() {
      this.booted = true
    }
    static before(event: string, handler: (...a: any[]) => any) {
      ;(hooks[event] ??= []).push(handler)
    }
  }
  const Scoped = withTenantScope(FakeBaseModel as any) as any
  Scoped.boot()
  return hooks
}

function withNodeEnv<T>(value: string, fn: () => T): T {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = value
  try {
    return fn()
  } finally {
    process.env.NODE_ENV = prev
  }
}

interface TripRecipe {
  /** Trips the guard; sync or async. Must throw the guard's own exception. */
  trip: () => unknown | Promise<unknown>
  /** The original (unchanged) exception's message must match this. */
  expectThrow: RegExp
  /** A happy input that must NOT emit. Omit when only a trip is meaningful. */
  happy?: () => unknown | Promise<unknown>
  /** The happy input may throw a NON-Isthmus downstream error (crypto/DB). */
  happyMayThrowNonGuard?: true
}

interface ViaIntegration {
  /** Repo-relative spec that asserts this guard's emission (existence + id-mention checked). */
  viaIntegration: string
}

type Recipe = TripRecipe | ViaIntegration

const isViaIntegration = (r: Recipe): r is ViaIntegration => 'viaIntegration' in r

const CORE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * Audit-pillar entries observe rather than gate, so the matrix covers gating
 * guards only. The exclusion is derived from the registry's literal types: a
 * new non-audit guard is a COMPILE error here until it gets a recipe, and a
 * new audit-pillar entry is excluded automatically.
 */
type AuditGuardId = Extract<(typeof ISTHMUS_REGISTRY)[number], { pillar: 'audit' }>['id']
type GatingGuardId = Exclude<IsthmusGuardId, AuditGuardId>

const TRIP_MATRIX: Record<GatingGuardId, Recipe> = {
  'guard.tenant_identifier': {
    // ASCII-only SAFE_IDENT fires before the NFKC clause; '℀' still trips it,
    // as input diversity, not as distinct NFKC-clause coverage.
    trip: () => assertSafeIdentifier('tenant@bad', 'tenant id'),
    expectThrow: /Refusing to use unsafe tenant id/,
    happy: () => assertSafeIdentifier(UUID, 'tenant id'),
  },
  'guard.redirect_host': {
    trip: () =>
      new CrossDomainRedirectService().toTenant(
        { customDomain: 'evil.com#@trusted.com' } as any,
        '/x'
      ),
    expectThrow: /unsafe host/,
    happy: () =>
      new CrossDomainRedirectService().toTenant({ customDomain: 'ok.example' } as any, '/x'),
  },
  'guard.redirect_host_label': {
    trip: () => new CrossDomainRedirectService().toTenantSubdomainHost('bad label'),
    expectThrow: /unsafe tenant slug/,
    happy: () => new CrossDomainRedirectService().toTenantSubdomainHost('acme'),
  },
  'guard.redirect_port': {
    trip: () =>
      new CrossDomainRedirectService().toTenant({ customDomain: 'ok.example' } as any, '/x', {
        // 0 is falsy, so the `opts.port ? …` guard skips it; use an out-of-range
        // truthy port so assertSafePort actually runs.
        port: 70000,
      }),
    expectThrow: /invalid port/,
    happy: () =>
      new CrossDomainRedirectService().toTenant({ customDomain: 'ok.example' } as any, '/x', {
        port: 8443,
      }),
  },
  'guard.redirect_path': {
    trip: () =>
      new CrossDomainRedirectService().toTenant({ customDomain: 'ok.example' } as any, 'a\r\nb'),
    expectThrow: /CR\/LF/,
    happy: () =>
      new CrossDomainRedirectService().toTenant({ customDomain: 'ok.example' } as any, '/ok'),
  },
  'guard.config_bounds': {
    trip: () => assertConfigBounds({ ...testConfig, circuitBreaker: { threshold: 0 } } as any),
    expectThrow: /circuitBreaker\.threshold must be/,
    happy: () => assertConfigBounds({ ...testConfig } as any),
  },
  'guard.resolution_safety': {
    // assertConfigBounds takes the config as an argument (never reads the
    // singleton), so no setConfig is needed inside the production flip.
    trip: () =>
      withNodeEnv('production', () =>
        assertConfigBounds({ ...testConfig, resolverStrategy: 'header' } as any)
      ),
    expectThrow: /membership|IDOR|authorizeTenantAccess|acknowledge/i,
    happy: () =>
      withNodeEnv('production', () =>
        assertConfigBounds({
          ...testConfig,
          resolverStrategy: 'header',
          acknowledgeNoMembershipGate: true,
        } as any)
      ),
  },
  'guard.resolver_chain': {
    trip: () => assertResolverChain({ resolverChain: ['unknown'] } as MultitenancyConfig),
    expectThrow: /unknown resolver/,
    happy: () => assertResolverChain({ resolverChain: ['header'] } as MultitenancyConfig),
  },
  'guard.metric_value': {
    trip: () => assertMetricValue(1.5),
    expectThrow: /Refusing to record metric value/,
    happy: () => assertMetricValue(3),
  },
  'guard.metrics_endpoint': {
    // Empty-array footgun: a dynamically-built middleware list that came out
    // empty must be treated as absent, not as "guarded".
    trip: () => assertMetricsGuarded(true, [] as any),
    expectThrow: /metricsMiddleware. is required/,
    happy: () => assertMetricsGuarded(true, false),
  },
  'guard.rls_guc_name': {
    trip: () => setTenantRlsGuc(recordingRunner(), UUID, { gucName: 'noclass' }),
    expectThrow: /unsafe RLS setting name/,
    happy: () => setTenantRlsGuc(recordingRunner(), UUID, { gucName: 'app.tenant_id' }),
  },
  'guard.broadcast_channel': {
    // tenantChannel (sync, no Transmit import), NOT tenantBroadcast, whose
    // normalizeChannel runs after `await lazyTransmit()`. Must run inside a
    // tenancy scope carrying a SAFE id, or it trips the "outside a scope" error
    // (or guard.tenant_identifier) instead of the channel guard.
    trip: () => tenancy.run({ id: UUID } as any, () => tenantChannel('a/../b')),
    expectThrow: /escape the per-tenant namespace/,
    happy: () => tenancy.run({ id: UUID } as any, () => tenantChannel('chat')),
  },
  'guard.outbound_fetch': {
    // Hermetic: an IP literal pins without DNS and trips url_blocks_private. No
    // happy recipe: a non-emitting fetch would make a real network call, which has
    // no place in a unit spec; the trusted-host happy path is covered in
    // security_safe_fetch.spec.ts.
    trip: () => safeFetch('https://10.0.0.1/x'),
    expectThrow: /refusing to fetch/i,
  },
  'guard.webhook_url': {
    // registerWebhook validates the URL before any crypto/model use, so the
    // trip is hermetic. No happy recipe: a valid URL proceeds into writeSecret
    // + TenantWebhook.create, which need a booted app; the happy path is covered
    // by the webhook integration specs.
    trip: () => new WebhookService().registerWebhook(UUID, 'http://insecure.example/hook', ['e']),
    expectThrow: /refusing to register an unsafe webhook url/i,
  },
  // Emits on a fail-closed DENY (a `return`, not a throw), so the in-file
  // trip-then-throw model does not apply; the authorizer spec captures the emit
  // via snapshotIsthmusCounters on the throw/timeout path.
  'guard.plugin_authorizer': {
    viaIntegration: 'tests/@guarantees/security/unit/security_authorizer_chain_fail_closed.spec.ts',
  },
  'guard.plugin_core_access': {
    // Untrusted plugin code on the stack reaching a core singleton funnel is
    // denied (in-process friction). With no scope, the caller is core's own
    // code and there is no denial, so the happy path is a plain no-op.
    trip: () =>
      pluginScope.run({ plugin: pluginName('sketchy'), trusted: false }, () =>
        assertCoreAccessAllowed('tenant-repository')
      ),
    expectThrow: /refusing untrusted plugin/,
    happy: () => assertCoreAccessAllowed('tenant-repository'),
  },
  'guard.plugin_capability_trust': {
    // An untrusted plugin providing a SENSITIVE capability is refused; an ordinary
    // (non-sensitive) provision from the same plugin is unaffected. 'sketchy' is
    // never on TRUSTED_SATELLITES, so the trip is deterministic without env setup.
    trip: () =>
      new CapabilityRegistry().register(
        { kind: 'capability', name: capabilityKey('secret_keys'), api: {}, sensitive: true },
        pluginName('sketchy')
      ),
    expectThrow: /refusing to provide sensitive capability/,
    happy: () =>
      new CapabilityRegistry().register(
        { kind: 'capability', name: capabilityKey('mailer'), api: {} },
        pluginName('sketchy')
      ),
  },
  'guard.plugin_extension_identifier': {
    // A hostile plugin identifier is rejected at the mint (the plugin surface),
    // emitting the dedicated guard rather than folding onto an existing id.
    trip: () => pluginName('bad:name'),
    expectThrow: /Refusing to mint unsafe plugin/,
    happy: () => pluginName('ok_name'),
  },
  'seal.scope_required': {
    trip: () => {
      const hooks = makeScopedModel()
      // No active tenancy scope and no unscoped(), so strict mode refuses.
      hooks.find![0]!({ where() {} })
    },
    expectThrow: /outside both tenancy\.run\(\) and unscoped/,
  },
  'seal.scope_owner_mismatch': {
    trip: async () => {
      const hooks = makeScopedModel()
      await tenancy.run({ id: UUID } as any, async () => {
        // Create a row explicitly owned by a DIFFERENT tenant.
        hooks.create![0]!({ tenant_id: '22222222-2222-4222-8222-222222222222' })
      })
    },
    expectThrow: /refusing to create a row owned by tenant/,
  },
  // Asserted in-file by the adapter unit spec (real emitter-capture assertions).
  'seal.tenant_context': {
    viaIntegration: 'tests/@guarantees/isolation/unit/isolation_tenant_adapter.spec.ts',
  },
  // Asserted by the searchpath-pin integration spec (extended with capture).
  'seal.connection_search_path': {
    viaIntegration:
      'tests/@guarantees/isolation/integration/isolation_schema_pg_searchpath_pin.spec.ts',
  },
}

function nonAuditIds(): GatingGuardId[] {
  // The runtime filter mirrors the type-level Extract on pillar 'audit'.
  return ISTHMUS_REGISTRY.filter((e) => e.pillar !== 'audit').map((e) => e.id) as GatingGuardId[]
}

test.group('Isthmus guard emission matrix — completeness', () => {
  test('every non-audit registry id has a matrix entry', ({ assert }) => {
    const missing = nonAuditIds().filter((id) => !(id in TRIP_MATRIX))
    assert.deepEqual(missing, [], `guards with no behavioral test: ${missing.join(', ')}`)
  })

  test('every matrix key is a real (non-audit) registry id', ({ assert }) => {
    const ids = new Set<string>(nonAuditIds())
    const stray = Object.keys(TRIP_MATRIX).filter((id) => !ids.has(id))
    assert.deepEqual(stray, [], `matrix keys not in the registry: ${stray.join(', ')}`)
  })

  test('every viaIntegration reference exists and actually names the guard id', ({ assert }) => {
    const problems: string[] = []
    for (const [id, recipe] of Object.entries(TRIP_MATRIX)) {
      if (!isViaIntegration(recipe)) continue
      const abs = fileURLToPath(new URL(recipe.viaIntegration, `file://${CORE_ROOT}`))
      const path = `${CORE_ROOT}${recipe.viaIntegration}`
      if (!existsSync(path)) {
        problems.push(`${id}: referenced spec missing (${recipe.viaIntegration})`)
        continue
      }
      const src = readFileSync(path, 'utf8')
      if (!src.includes(id)) {
        problems.push(`${id}: referenced spec never names the guard id — false-positive reference`)
      }
      void abs
    }
    assert.deepEqual(problems, [], problems.join('\n'))
  })
})

test.group('Isthmus guard emission matrix — trip + happy', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetIsthmusCounters()
    __resetIsthmusRateLimit()
    __setIsthmusDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
    // Redirect + broadcast happy paths read the config singleton.
    __resetConfigForTests()
    setConfig({ ...testConfig })
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
  })

  group.each.teardown(() => {
    __setIsthmusDispatcherForTests(undefined)
    __resetIsthmusCounters()
    __resetIsthmusRateLimit()
    __configureTenancyForTests({})
  })

  for (const id of Object.keys(TRIP_MATRIX) as GatingGuardId[]) {
    const recipe = TRIP_MATRIX[id]
    if (isViaIntegration(recipe)) continue
    const entry = ISTHMUS_REGISTRY.find((e) => e.id === id)!

    test(`${id}: tripping emits exactly one matching event, unchanged exception`, async ({
      assert,
    }) => {
      let threw: unknown
      try {
        await recipe.trip()
      } catch (err) {
        threw = err
      }
      await settle()

      assert.isDefined(threw, `${id}: trip recipe did not throw`)
      assert.match((threw as Error).message, recipe.expectThrow, `${id}: exception message changed`)

      assert.lengthOf(captured, 1, `${id}: expected exactly one dispatch`)
      assert.equal(captured[0]!.id, id)
      assert.equal(captured[0]!.severity, entry.severity)
      assert.equal(captured[0]!.event, entry.event)
      assert.equal(captured[0]!.pillar, entry.pillar)

      // Metadata values are short (truncated by the guards to <= 64 chars).
      for (const value of Object.values(captured[0]!.metadata)) {
        if (typeof value === 'string') assert.isAtMost(value.length, 64, `${id}: metadata too long`)
      }

      const snapshot = snapshotIsthmusCounters()
      const guarded = snapshot.guarded
        .filter(
          (g) => g.pillar === (entry.pillar as IsthmusPillar) && g.severity === entry.severity
        )
        .reduce((sum, g) => sum + g.value, 0)
      assert.equal(guarded, 1, `${id}: guarded delta must be exactly 1`)
      assert.equal(
        snapshot.rejected.find((r) => r.id === id)?.value ?? 0,
        1,
        `${id}: rejected delta must be exactly 1`
      )
    })

    if (recipe.happy) {
      test(`${id}: a happy input emits nothing`, async ({ assert }) => {
        try {
          await recipe.happy!()
        } catch (err) {
          if (!recipe.happyMayThrowNonGuard) throw err
          // A downstream non-Isthmus error (crypto/DB/network) is tolerated;
          // the contract is only "the guard did not fire".
        }
        await settle()

        assert.lengthOf(captured, 0, `${id}: happy input must not emit`)
        const snapshot = snapshotIsthmusCounters()
        assert.lengthOf(snapshot.guarded, 0, `${id}: happy input must not bump guarded`)
        assert.lengthOf(snapshot.rejected, 0, `${id}: happy input must not bump rejected`)
      })
    }
  }
})
