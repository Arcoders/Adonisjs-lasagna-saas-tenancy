import { test } from '@japa/runner'
import {
  parseWithFlag,
  filterUnknown,
  resolveMigrationStubs,
  partitionSatellitesByApiCompat,
  ALL_FEATURES,
  KNOWN_FEATURES,
} from '../../../../configure.js'
import type { DiscoveredSatellite, SatelliteDependency } from '../../../../src/sdk/manifest.js'

test.group('configure — parseWithFlag', () => {
  test('returns null for undefined and null (flag absent)', ({ assert }) => {
    assert.isNull(parseWithFlag(undefined))
    assert.isNull(parseWithFlag(null))
  })

  test('returns an empty array for an empty string', ({ assert }) => {
    assert.deepEqual(parseWithFlag(''), [])
  })

  test('splits a CSV string into trimmed feature names', ({ assert }) => {
    assert.deepEqual(parseWithFlag('audit,billing'), ['audit', 'billing'])
  })

  test('flattens an array input, splitting CSV entries', ({ assert }) => {
    assert.deepEqual(parseWithFlag(['audit,billing', 'sso']), ['audit', 'billing', 'sso'])
  })

  test('trims surrounding whitespace and drops empty segments', ({ assert }) => {
    assert.deepEqual(parseWithFlag(' audit , , billing ,'), ['audit', 'billing'])
  })

  test('returns null for non-string, non-array input', ({ assert }) => {
    assert.isNull(parseWithFlag(42))
    assert.isNull(parseWithFlag({ with: 'audit' }))
  })
})

test.group('configure — filterUnknown', () => {
  test('splits known from unknown feature names', ({ assert }) => {
    assert.deepEqual(filterUnknown(['audit', 'bogus']), {
      known: ['audit'],
      unknown: ['bogus'],
    })
  })

  test('treats rls as known (opt-in bundle)', ({ assert }) => {
    assert.deepEqual(filterUnknown(['rls']), { known: ['rls'], unknown: [] })
  })

  test('keeps everything when all features are known', ({ assert }) => {
    assert.deepEqual(filterUnknown(['audit', 'metrics']), {
      known: ['audit', 'metrics'],
      unknown: [],
    })
  })

  test('treats the (now external) billing/sso short names as unknown core features', ({
    assert,
  }) => {
    // billing/sso migrations moved to their own packages; they are no longer
    // core bundles. configure() routes these through external discovery + the
    // legacy-alias hint, not filterUnknown.
    assert.deepEqual(filterUnknown(['billing', 'sso']), {
      known: [],
      unknown: ['billing', 'sso'],
    })
  })
})

test.group('configure — resolveMigrationStubs', () => {
  test('flattens a multi-stub core bundle in order (webhooks)', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['webhooks']), [
      'create_tenant_webhooks_table',
      'create_tenant_webhook_deliveries_table',
    ])
  })

  test('maps single-stub satellites to their one migration', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['audit']), ['create_tenant_audit_logs_table'])
  })

  test('resolves the opt-in rls bundle', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['rls']), ['enable_rls_tenant_isolation'])
  })

  test('skips unknown features (no bundle)', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['bogus']), [])
  })

  test('skips the external billing/sso names (no core bundle)', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['billing', 'sso']), [])
  })

  test('concatenates a multi-feature list in selection then bundle order', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['audit', 'webhooks']), [
      'create_tenant_audit_logs_table',
      'create_tenant_webhooks_table',
      'create_tenant_webhook_deliveries_table',
    ])
  })
})

test.group('configure — default feature contract', () => {
  test('ALL_FEATURES excludes the opt-in bundles (never auto-published)', ({ assert }) => {
    assert.notInclude(ALL_FEATURES, 'rls')
    assert.notInclude(ALL_FEATURES, 'maintenance')
  })

  test('ALL_FEATURES includes the quotas satellite', ({ assert }) => {
    assert.include(ALL_FEATURES, 'quotas')
  })

  test('KNOWN_FEATURES is the union of satellites and opt-in bundles', ({ assert }) => {
    assert.deepEqual(KNOWN_FEATURES, [...ALL_FEATURES, 'rls', 'rls-backoffice', 'maintenance'])
  })

  test('rls-backoffice is opt-in (never auto-published) and resolves to its stub', ({ assert }) => {
    assert.notInclude(ALL_FEATURES, 'rls-backoffice')
    assert.deepEqual(resolveMigrationStubs(['rls-backoffice']), ['enable_rls_backoffice_isolation'])
  })
})

test.group('configure — quotas & maintenance bundles', () => {
  test('quotas resolves to the shared tenant_plans table', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['quotas']), ['create_tenant_plans_table'])
  })

  test('maintenance resolves to the tenants-table alter (opt-in)', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['maintenance']), ['add_maintenance_to_tenants_table'])
    assert.deepEqual(filterUnknown(['maintenance']), { known: ['maintenance'], unknown: [] })
  })

  test('metrics resolves to the daily, custom, and monthly-rollup tables', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['metrics']), [
      'create_tenant_metrics_table',
      'create_tenant_custom_metrics_table',
      'create_tenant_metrics_monthly_table',
    ])
  })
})

test.group('configure — dedup across overlapping selections', () => {
  test('a repeated feature emits its stub exactly once', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['quotas', 'quotas']), ['create_tenant_plans_table'])
  })

  test('a stub never appears twice for any selection', ({ assert }) => {
    const stubs = resolveMigrationStubs(['quotas', 'metrics', 'audit', 'webhooks'])
    assert.deepEqual([...new Set(stubs)], stubs)
  })
})

test.group('configure — incremental additivity', () => {
  test('a later selection never re-emits a stub from an earlier disjoint one', ({ assert }) => {
    // First install: audit + webhooks. Later: every other core feature.
    const first = resolveMigrationStubs(['audit', 'webhooks'])
    const later = resolveMigrationStubs(['metrics', 'branding', 'feature_flags', 'quotas'])
    const overlap = first.filter((s) => later.includes(s))
    assert.deepEqual(overlap, [], 'no migration published by the first run reappears in the second')
  })
})

test.group('configure — partitionSatellitesByApiCompat (ABI gate enforcement)', () => {
  // The pure compat comparison itself is covered in tests/unit/sdk/api_version.spec.ts.
  // These cases prove configure's ENFORCEMENT: which satellites it refuses to wire,
  // the dependency-refusal cascade, and the warnings it surfaces. A fixed
  // `coreApiVersion` keeps the assertions stable across future ABI bumps.
  const CORE = 5

  function sat(
    packageName: string,
    satelliteApi: number | undefined,
    dependsOn?: SatelliteDependency[]
  ): DiscoveredSatellite {
    return {
      packageName,
      root: `/fake/${packageName}`,
      manifest: { name: packageName, satelliteApi, dependsOn },
    }
  }

  function indexOf(...sats: DiscoveredSatellite[]): Map<string, DiscoveredSatellite> {
    const map = new Map<string, DiscoveredSatellite>()
    for (const s of sats) {
      map.set(s.packageName, s)
      for (const alias of s.manifest.aliases ?? []) map.set(alias, s)
    }
    return map
  }

  test('accepts a satellite built against the exact core ABI', ({ assert }) => {
    const ok = sat('@x/ok', CORE)
    const result = partitionSatellitesByApiCompat([ok], indexOf(ok), CORE)
    assert.deepEqual(
      result.accepted.map((s) => s.packageName),
      ['@x/ok']
    )
    assert.lengthOf(result.refused, 0)
    assert.lengthOf(result.warnings, 0)
  })

  test('refuses a satellite that needs a NEWER ABI than the core provides', ({ assert }) => {
    const tooNew = sat('@x/too-new', CORE + 1)
    const result = partitionSatellitesByApiCompat([tooNew], indexOf(tooNew), CORE)
    assert.lengthOf(result.accepted, 0)
    assert.lengthOf(result.refused, 1)
    assert.equal(result.refused[0].packageName, '@x/too-new')
    assert.match(result.refused[0].reason, /requires Satellite ABI v6/)
  })

  test('accepts an OLDER-ABI satellite but surfaces a warning', ({ assert }) => {
    const older = sat('@x/older', CORE - 1)
    const result = partitionSatellitesByApiCompat([older], indexOf(older), CORE)
    assert.deepEqual(
      result.accepted.map((s) => s.packageName),
      ['@x/older']
    )
    assert.lengthOf(result.refused, 0)
    assert.lengthOf(result.warnings, 1)
    assert.match(result.warnings[0], /built for Satellite ABI v4/)
  })

  test('accepts an undeclared-ABI satellite with an "unverified" warning', ({ assert }) => {
    const undeclared = sat('@x/legacy', undefined)
    const result = partitionSatellitesByApiCompat([undeclared], indexOf(undeclared), CORE)
    assert.deepEqual(
      result.accepted.map((s) => s.packageName),
      ['@x/legacy']
    )
    assert.match(result.warnings[0], /does not declare/)
  })

  test('cascades the refusal: a dependent of a refused satellite is refused too', ({ assert }) => {
    // Dependency-first order (the closure configure passes): the failing dep is
    // seen before its dependent, so the dependent is dropped without being wired.
    const dep = sat('@x/dep', CORE + 1) // needs a newer ABI → fail
    const dependent = sat('@x/app', CORE, [{ pkg: '@x/dep' }])
    const result = partitionSatellitesByApiCompat([dep, dependent], indexOf(dep, dependent), CORE)

    assert.lengthOf(result.accepted, 0)
    assert.deepEqual(result.refused.map((r) => r.packageName).sort(), ['@x/app', '@x/dep'])
    assert.match(
      result.refused.find((r) => r.packageName === '@x/app')!.reason,
      /depends on "@x\/dep", which was refused above/
    )
  })

  test('resolves a dependency alias through the index when cascading a refusal', ({ assert }) => {
    // The dependent declares its dep via an alias; the index maps it to the real
    // package name, so the cascade still fires.
    const dep: DiscoveredSatellite = {
      packageName: '@x/dep',
      root: '/fake/dep',
      manifest: { name: 'dep', satelliteApi: CORE + 1, aliases: ['dep-alias'] },
    }
    const dependent = sat('@x/app', CORE, [{ pkg: 'dep-alias' }])
    const result = partitionSatellitesByApiCompat([dep, dependent], indexOf(dep, dependent), CORE)

    assert.lengthOf(result.accepted, 0)
    assert.deepEqual(result.refused.map((r) => r.packageName).sort(), ['@x/app', '@x/dep'])
  })

  test('keeps a healthy sibling while refusing only the incompatible one', ({ assert }) => {
    const ok = sat('@x/ok', CORE)
    const bad = sat('@x/bad', CORE + 2)
    const result = partitionSatellitesByApiCompat([ok, bad], indexOf(ok, bad), CORE)

    assert.deepEqual(
      result.accepted.map((s) => s.packageName),
      ['@x/ok']
    )
    assert.deepEqual(
      result.refused.map((r) => r.packageName),
      ['@x/bad']
    )
  })
})

// `filterAlreadyPublished` moved to the satellite toolkit; its idempotency-guard
// coverage lives in tests/unit/satellite/configure_kit.spec.ts.
