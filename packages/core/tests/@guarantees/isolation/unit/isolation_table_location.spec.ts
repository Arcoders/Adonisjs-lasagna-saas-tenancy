import { test } from '@japa/runner'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import DatabasePgDriver from '../../../../src/services/isolation/database_pg_driver.js'
import RowScopePgDriver from '../../../../src/services/isolation/rowscope_pg_driver.js'
import SqliteMemoryDriver from '../../../../src/services/isolation/sqlite_memory_driver.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import { DEFAULT_RLS_GUC } from '../../../../src/services/isolation/rls.js'
import {
  ISOLATION_CONTRACT_VERSION,
  type IsolationDriver,
  type IsolationDriverName,
  type TableLocation,
} from '../../../../src/services/isolation/driver.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

const fakeTenant = (id: string) => ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

/**
 * A total consumer of the closed union. Its `default: never` branch is the
 * compile-time proof that every `kind` is handled: if a fifth variant is ever
 * added to `TableLocation` without updating this switch, `const _exhaustive:
 * never = loc` stops compiling and `npm run typecheck` fails. At runtime it
 * also exercises every variant's discriminant, so the drivers below assert
 * against a value that survived the exhaustive switch.
 */
function placementSummary(loc: TableLocation): string {
  switch (loc.kind) {
    case 'schema':
      return `schema:${loc.schema}@${loc.connectionName}`
    case 'database':
      return `database:${loc.database}@${loc.connectionName}`
    case 'rowscope':
      return `rowscope:${loc.scopeColumn}(rls=${loc.rls})@${loc.connectionName}`
    case 'connection':
      return `connection:${loc.connectionName}`
    default: {
      const _exhaustive: never = loc
      return _exhaustive
    }
  }
}

function captureWarn(fn: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  ;(console as any).warn = (m: string) => warnings.push(String(m))
  try {
    fn()
  } finally {
    ;(console as any).warn = original
  }
  return warnings
}

test.group('tableLocation — schema-pg', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reports the tenant schema, the routing connection, and no namespace lies', ({ assert }) => {
    const loc = new SchemaPgDriver().tableLocation(fakeTenant('abc'))
    assert.deepEqual(loc, {
      kind: 'schema',
      schema: 'tenant_abc',
      connectionName: 'tenant_abc',
    })
    // The connection the placement names is exactly the one routing uses.
    assert.equal(loc.connectionName, new SchemaPgDriver().connectionName('abc'))
    assert.equal(placementSummary(loc), 'schema:tenant_abc@tenant_abc')
  })

  test('honors a custom schema/connection prefix from config', ({ assert }) => {
    setupTestConfig({ tenantSchemaPrefix: 'sch_', tenantConnectionNamePrefix: 'pool_' })
    const loc = new SchemaPgDriver().tableLocation(fakeTenant('1'))
    assert.deepEqual(loc, { kind: 'schema', schema: 'sch_1', connectionName: 'pool_1' })
  })

  test('fails closed on an unsafe tenant id (never yields an injectable namespace)', ({
    assert,
  }) => {
    const driver = new SchemaPgDriver()
    assert.throws(() => driver.tableLocation(fakeTenant('bad"id')), /unsafe|tenant id/i)
    assert.throws(() => driver.tableLocation(fakeTenant('a b')), /unsafe|tenant id/i)
  })
})

test.group('tableLocation — database-pg', (group) => {
  group.each.setup(() => setupTestConfig())

  test('reports the tenant database and the routing connection', ({ assert }) => {
    const loc = new DatabasePgDriver().tableLocation(fakeTenant('abc'))
    assert.deepEqual(loc, {
      kind: 'database',
      database: 'tenant_abc',
      connectionName: 'tenant_abc',
    })
    assert.equal(placementSummary(loc), 'database:tenant_abc@tenant_abc')
  })

  test('reflects the driver databasePrefix, matching where connect() points', ({ assert }) => {
    const loc = new DatabasePgDriver({ databasePrefix: 'db_' }).tableLocation(fakeTenant('7'))
    assert.deepEqual(loc, { kind: 'database', database: 'db_7', connectionName: 'tenant_7' })
  })

  test('fails closed on an unsafe tenant id', ({ assert }) => {
    assert.throws(
      () => new DatabasePgDriver().tableLocation(fakeTenant('a";DROP')),
      /unsafe|tenant id/i
    )
  })
})

test.group('tableLocation — rowscope-pg', (group) => {
  group.each.setup(() => setupTestConfig())

  test('carries the scope column and the shared connection, and NO schema/database key', ({
    assert,
  }) => {
    const loc = new RowScopePgDriver().tableLocation(fakeTenant('abc'))
    assert.deepEqual(loc, {
      kind: 'rowscope',
      scopeColumn: 'tenant_id',
      rls: false,
      connectionName: 'public',
    })
    // The exact I1 leak this seam prevents: rowscope has no per-tenant namespace.
    assert.isFalse('schema' in loc)
    assert.isFalse('database' in loc)
    // rlsGuc is present ONLY when rls is on (present iff rls).
    assert.isFalse('rlsGuc' in loc)
    assert.equal(placementSummary(loc), 'rowscope:tenant_id(rls=false)@public')
  })

  test('reports rls=true and the GUC when isolation.rowScopeRls is enabled', ({ assert }) => {
    setupTestConfig({ isolation: { rowScopeRls: true } })
    const loc = new RowScopePgDriver().tableLocation(fakeTenant('abc'))
    assert.deepEqual(loc, {
      kind: 'rowscope',
      scopeColumn: 'tenant_id',
      rls: true,
      rlsGuc: DEFAULT_RLS_GUC,
      connectionName: 'public',
    })
  })

  test('honors a custom scope column', ({ assert }) => {
    const loc = new RowScopePgDriver({ scopeColumn: 'org_id' }).tableLocation(fakeTenant('abc'))
    assert.equal(loc.kind, 'rowscope')
    assert.equal((loc as Extract<TableLocation, { kind: 'rowscope' }>).scopeColumn, 'org_id')
  })

  test('fails closed on an unsafe tenant id even though routing ignores it', ({ assert }) => {
    // connectionName() returns the shared central name without asserting the id,
    // so tableLocation must assert defensively so a malformed id never travels
    // in a placement value (logs, DDL builders, hooks).
    assert.throws(
      () => new RowScopePgDriver().tableLocation(fakeTenant('a b')),
      /unsafe|tenant id/i
    )
  })
})

test.group('tableLocation — sqlite-memory', (group) => {
  group.each.setup(() => setupTestConfig())

  test('the connection IS the namespace: kind=connection, no schema/database', ({ assert }) => {
    const loc = new SqliteMemoryDriver().tableLocation(fakeTenant('abc'))
    assert.deepEqual(loc, { kind: 'connection', connectionName: 'tenant_abc' })
    assert.isFalse('schema' in loc)
    assert.isFalse('database' in loc)
    assert.equal(placementSummary(loc), 'connection:tenant_abc')
  })

  test('fails closed on an unsafe tenant id', ({ assert }) => {
    assert.throws(
      () => new SqliteMemoryDriver().tableLocation(fakeTenant('bad"id')),
      /unsafe|tenant id/i
    )
  })
})

test.group('tableLocation — contract version', () => {
  test('ISOLATION_CONTRACT_VERSION is 2 and every shipped driver declares it', ({ assert }) => {
    assert.equal(ISOLATION_CONTRACT_VERSION, 2)
    assert.equal(new SchemaPgDriver().contractVersion, 2)
    assert.equal(new DatabasePgDriver().contractVersion, 2)
    assert.equal(new RowScopePgDriver().contractVersion, 2)
    assert.equal(new SqliteMemoryDriver().contractVersion, 2)
  })
})

/**
 * The registration presence gate. `assertContractCompat` only WARNS for a driver
 * declaring an older or absent contractVersion, so the v1->v2 bump alone would
 * let a driver missing tableLocation() register and then crash the first time a
 * satellite asks it where a tenant's data lives. The gate runs UNCONDITIONALLY,
 * independent of the declared version, so v1, unversioned, and present-method
 * drivers are all decided at registration.
 */
test.group('IsolationDriverRegistry — tableLocation presence gate', (group) => {
  group.each.setup(() => setupTestConfig())

  function driverWithout(tableLocation: boolean, contractVersion?: number): IsolationDriver {
    const base: Record<string, unknown> = {
      name: 'custom' as IsolationDriverName,
      contractVersion,
      enforce() {},
      async destroy() {},
      async reset() {},
      async connect() {
        return {} as never
      },
      async disconnect() {},
      connectionName() {
        return 'conn:custom'
      },
      async migrate() {
        return { executed: 0 }
      },
    }
    if (tableLocation) {
      base.tableLocation = () => ({ kind: 'connection', connectionName: 'conn:custom' })
    }
    return base as unknown as IsolationDriver
  }

  test('a driver missing tableLocation() at contractVersion 1 is refused at registration', ({
    assert,
  }) => {
    const reg = new IsolationDriverRegistry()
    // Swallow the expected v1<v2 warning so it does not pollute the run.
    captureWarn(() => {
      assert.throws(() => reg.register(driverWithout(false, 1)), /tableLocation/)
    })
    assert.isFalse(reg.has('custom'))
  })

  test('a driver missing tableLocation() with NO contractVersion is refused (unconditional gate)', ({
    assert,
  }) => {
    const reg = new IsolationDriverRegistry()
    captureWarn(() => {
      assert.throws(() => reg.register(driverWithout(false, undefined)), /tableLocation/)
    })
    assert.isFalse(reg.has('custom'))
  })

  test('a driver implementing tableLocation() at v2 registers', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    assert.doesNotThrow(() => reg.register(driverWithout(true, 2)))
    assert.isTrue(reg.has('custom'))
  })

  test('a v1 driver that DOES implement tableLocation() still registers, with the version warning', ({
    assert,
  }) => {
    const reg = new IsolationDriverRegistry()
    const warnings = captureWarn(() => reg.register(driverWithout(true, 1)))
    assert.isTrue(reg.has('custom'))
    assert.isTrue(warnings.some((w) => /contractVersion|contract v/.test(w)))
  })
})
