import { test } from '@japa/runner'
import {
  parseWithFlag,
  filterUnknown,
  resolveMigrationStubs,
  ALL_FEATURES,
  KNOWN_FEATURES,
} from '../../configure.js'

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
    assert.deepEqual(KNOWN_FEATURES, [...ALL_FEATURES, 'rls', 'maintenance'])
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

  test('metrics resolves to its single table', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['metrics']), ['create_tenant_metrics_table'])
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

// `filterAlreadyPublished` moved to the satellite toolkit; its idempotency-guard
// coverage lives in tests/unit/satellite/configure_kit.spec.ts.
