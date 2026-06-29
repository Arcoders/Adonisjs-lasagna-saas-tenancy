import { test } from '@japa/runner'
import { isDependencyOutageError } from '../../../../src/utils/dependency_outage.js'
import { mapTenantQueryError, mapTenantConnectError } from '../../../../src/extensions/request.js'
import DependencyUnavailableException from '../../../../src/exceptions/dependency_unavailable_exception.js'

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
    [
      'Lucid unregistered connection E_UNMANAGED_DB_CONNECTION (carries a 500)',
      {
        code: 'E_UNMANAGED_DB_CONNECTION',
        status: 500,
        message: 'Cannot connect to unregistered connection tenant_x',
      },
    ],
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

  test('passes a non-outage decided HTTP status through untouched', ({ assert }) => {
    const decided = Object.assign(new Error('forbidden'), { status: 403 })
    assert.strictEqual(mapTenantQueryError(decided, 'tenant-7'), decided)
  })

  test('maps an outage to 503 even when it carries a status (Lucid 500)', ({ assert }) => {
    const outageWithStatus = Object.assign(new Error('unregistered connection'), {
      code: 'E_UNMANAGED_DB_CONNECTION',
      status: 500,
    })
    const mapped = mapTenantQueryError(outageWithStatus, 'tenant-7')
    assert.instanceOf(mapped, DependencyUnavailableException)
    assert.equal((mapped as DependencyUnavailableException).status, 503)
  })
})

test.group('mapTenantConnectError', () => {
  test('maps an unregistered-connection 500 to a 503 (the fail-closed bug fix)', ({ assert }) => {
    // The exact shape Lucid throws from the circuit probe / connect when a
    // tenant's pool was never established. It carries a 500, but it is a transient
    // connection-infrastructure failure and must fail closed as a retry-able 503.
    const err = Object.assign(new Error('Cannot connect to unregistered connection tenant_x'), {
      code: 'E_UNMANAGED_DB_CONNECTION',
      status: 500,
    })
    const mapped = mapTenantConnectError('tenant.connect', err, 'tenant-7')
    assert.instanceOf(mapped, DependencyUnavailableException)
    assert.equal((mapped as DependencyUnavailableException).status, 503)
    assert.equal((mapped as DependencyUnavailableException).operation, 'tenant.connect')
  })

  test('respects a genuinely decided non-outage status (e.g. the hard-cap 503 / config 500)', ({
    assert,
  }) => {
    const decided = Object.assign(new Error('connection limit'), { status: 503, code: 'E_X' })
    assert.strictEqual(mapTenantConnectError('tenant.connect', decided, 'tenant-7'), decided)
  })

  test('defaults an undecided backend error to a 503', ({ assert }) => {
    const mapped = mapTenantConnectError('tenant.lookup', new Error('central db down'), 'tenant-7')
    assert.instanceOf(mapped, DependencyUnavailableException)
    assert.equal((mapped as DependencyUnavailableException).status, 503)
    assert.equal((mapped as DependencyUnavailableException).operation, 'tenant.lookup')
  })
})
