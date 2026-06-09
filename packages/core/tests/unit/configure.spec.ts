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
      'create_stripe_customers_table',
      'create_stripe_subscriptions_table',
      'create_stripe_processed_events_table',
      'create_stripe_meter_events_table',
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
  test('ALL_FEATURES excludes rls (never auto-published)', ({ assert }) => {
    assert.notInclude(ALL_FEATURES, 'rls')
  })

  test('KNOWN_FEATURES is the union of satellites and opt-in bundles', ({ assert }) => {
    assert.deepEqual(KNOWN_FEATURES, [...ALL_FEATURES, 'rls'])
  })
})
