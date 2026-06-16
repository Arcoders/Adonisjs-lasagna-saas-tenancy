import { test } from '@japa/runner'
import {
  parseWithFlag,
  filterUnknown,
  resolveMigrationStubs,
  filterAlreadyPublished,
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
    assert.deepEqual(filterUnknown(['audit', 'billing']), {
      known: ['audit', 'billing'],
      unknown: [],
    })
  })
})

test.group('configure — resolveMigrationStubs', () => {
  test('flattens the billing bundle in order', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['billing']), [
      'create_tenant_plans_table',
      'create_billing_customers_table',
      'create_billing_subscriptions_table',
      'create_billing_processed_events_table',
      'create_billing_usage_events_table',
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

  test('concatenates a multi-feature list in selection then bundle order', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['audit', 'webhooks', 'sso']), [
      'create_tenant_audit_logs_table',
      'create_tenant_webhooks_table',
      'create_tenant_webhook_deliveries_table',
      'create_tenant_sso_configs_table',
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

test.group('configure — dedup across overlapping bundles', () => {
  test('quotas + billing emits tenant_plans exactly once, plans first', ({ assert }) => {
    assert.deepEqual(resolveMigrationStubs(['quotas', 'billing']), [
      'create_tenant_plans_table',
      'create_billing_customers_table',
      'create_billing_subscriptions_table',
      'create_billing_processed_events_table',
      'create_billing_usage_events_table',
    ])
  })

  test('billing + quotas is identical to billing alone (plans already leads)', ({ assert }) => {
    assert.deepEqual(
      resolveMigrationStubs(['billing', 'quotas']),
      resolveMigrationStubs(['billing'])
    )
  })

  test('a stub never appears twice for any selection', ({ assert }) => {
    const stubs = resolveMigrationStubs(['quotas', 'billing', 'metrics', 'audit'])
    assert.deepEqual([...new Set(stubs)], stubs)
  })
})

test.group('configure — incremental additivity', () => {
  test('a later selection never re-emits a stub from an earlier disjoint one', ({ assert }) => {
    // First install: audit + webhooks. Later: everything else.
    const first = resolveMigrationStubs(['audit', 'webhooks'])
    const later = resolveMigrationStubs([
      'billing',
      'metrics',
      'sso',
      'branding',
      'feature_flags',
      'quotas',
    ])
    const overlap = first.filter((s) => later.includes(s))
    assert.deepEqual(overlap, [], 'no migration published by the first run reappears in the second')
  })
})

test.group('configure — filterAlreadyPublished (idempotency guard)', () => {
  test('publishes everything when the migrations dir is empty', ({ assert }) => {
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_tenant_audit_logs_table', 'create_tenant_plans_table'],
      []
    )
    assert.deepEqual(toPublish, ['create_tenant_audit_logs_table', 'create_tenant_plans_table'])
    assert.deepEqual(skipped, [])
  })

  test('skips a stub already present under any timestamp prefix', ({ assert }) => {
    const existing = ['1700000000000_create_tenant_audit_logs_table.ts']
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_tenant_audit_logs_table', 'create_tenant_plans_table'],
      existing
    )
    assert.deepEqual(skipped, ['create_tenant_audit_logs_table'])
    assert.deepEqual(toPublish, ['create_tenant_plans_table'])
  })

  test('matches on the full stub name, not a prefix (no false positives)', ({ assert }) => {
    // A file for a *different* table must not mask a stub.
    const existing = ['1700000000001_create_tenant_webhooks_table.ts']
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_tenant_webhook_deliveries_table'],
      existing
    )
    assert.deepEqual(skipped, [])
    assert.deepEqual(toPublish, ['create_tenant_webhook_deliveries_table'])
  })

  test('ignores files that do not match the <digits>_<stub>.ts shape', ({ assert }) => {
    const existing = ['create_tenant_audit_logs_table.ts', 'README.md', '.gitkeep']
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_tenant_audit_logs_table'],
      existing
    )
    assert.deepEqual(skipped, [])
    assert.deepEqual(toPublish, ['create_tenant_audit_logs_table'])
  })

  test('a full re-run of an installed set skips everything', ({ assert }) => {
    const installed = resolveMigrationStubs(['audit', 'webhooks']).map(
      (s, i) => `170000000000${i}_${s}.ts`
    )
    const { toPublish, skipped } = filterAlreadyPublished(
      resolveMigrationStubs(['audit', 'webhooks']),
      installed
    )
    assert.deepEqual(toPublish, [])
    assert.lengthOf(skipped, 3)
  })
})
