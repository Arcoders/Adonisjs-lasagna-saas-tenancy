import { test } from '@japa/runner'
import { isDependencyOutageError } from '../../../src/utils/dependency_outage.js'
import { mapTenantQueryError } from '../../../src/extensions/request.js'
import DependencyUnavailableException from '../../../src/exceptions/dependency_unavailable_exception.js'

/**
 * WS-9 / no-pg-outage-mid-transaction-test (the FIX half).
 *
 * A tenant backend severed mid-handler (failover, admin `pg_terminate_backend`,
 * crash) used to bubble a raw Lucid 500 — opaque and read as non-retryable —
 * even though Postgres had already rolled the aborted transaction back. The
 * query-phase mapper turns ONLY unambiguous connection-loss signatures into a
 * clean, retry-able 503, and passes ordinary query errors (constraint
 * violations, type casts) straight through to the host handler.
 *
 * RED (pre-fix): no classifier / mapper existed (`ERR_MODULE_NOT_FOUND`);
 * severed-connection errors reached the host as a 500.
 */
test.group('dependency-outage classifier', () => {
  // Positive controls — these MUST map to a 503.
  const outages: Array<[string, any]> = [
    ['ECONNRESET socket error', { code: 'ECONNRESET' }],
    ['ECONNREFUSED socket error', { code: 'ECONNREFUSED' }],
    ['EPIPE socket error', { code: 'EPIPE' }],
    ['pg admin_shutdown 57P01', { code: '57P01', message: 'terminating connection' }],
    ['pg connection_failure 08006', { code: '08006' }],
    ['pg cannot_connect_now 57P03', { code: '57P03' }],
    ['pg too_many_connections 53300', { code: '53300' }],
    [
      'node-pg "Connection terminated" (no code)',
      { message: 'Connection terminated unexpectedly' },
    ],
    [
      'admin command message (no code)',
      { message: 'terminating connection due to administrator command' },
    ],
    ['server closed the connection', { message: 'server closed the connection unexpectedly' }],
  ]

  for (const [label, err] of outages) {
    test(`treats ${label} as a dependency outage`, ({ assert }) => {
      assert.isTrue(isDependencyOutageError(err))
    })
  }

  // Negative controls — ordinary query/application errors MUST pass through.
  const passthrough: Array<[string, any]> = [
    ['unique_violation 23505', { code: '23505', message: 'duplicate key value' }],
    ['foreign_key_violation 23503', { code: '23503' }],
    ['not_null_violation 23502', { code: '23502' }],
    ['invalid_text_representation 22P02', { code: '22P02' }],
    ['syntax_error 42601', { code: '42601' }],
    ['plain Error', new Error('something app-level broke')],
    ['null', null],
    ['undefined', undefined],
    ['string', 'not an object'],
  ]

  for (const [label, err] of passthrough) {
    test(`does NOT treat ${label} as a dependency outage`, ({ assert }) => {
      assert.isFalse(isDependencyOutageError(err))
    })
  }
})

test.group('mapTenantQueryError', () => {
  test('maps a severed-connection error to a 503 DependencyUnavailableException', ({ assert }) => {
    const mapped = mapTenantQueryError({ code: 'ECONNRESET' }, 'tenant-7')
    assert.instanceOf(mapped, DependencyUnavailableException)
    assert.equal((mapped as DependencyUnavailableException).status, 503)
    assert.equal((mapped as DependencyUnavailableException).tenantId, 'tenant-7')
    assert.equal((mapped as DependencyUnavailableException).operation, 'tenant.query')
  })

  test('passes an ordinary query error through untouched', ({ assert }) => {
    const original = Object.assign(new Error('duplicate key'), { code: '23505' })
    assert.strictEqual(mapTenantQueryError(original, 'tenant-7'), original)
  })

  test('passes an already-decided HTTP status through untouched', ({ assert }) => {
    const decided = Object.assign(new Error('forbidden'), { status: 403, code: 'ECONNRESET' })
    // Even though it carries an outage code, a decided status wins (the layer
    // that threw it already chose the response).
    assert.strictEqual(mapTenantQueryError(decided, 'tenant-7'), decided)
  })
})
