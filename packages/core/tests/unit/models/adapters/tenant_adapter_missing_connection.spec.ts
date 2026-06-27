import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import IsolationConfigException from '../../../../src/exceptions/isolation_config_exception.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'

/**
 * WS-1 / adapter-assumes-connection-preregistered.
 *
 * The adapter resolves a tenant connection NAME and hands it to Lucid, but
 * it never registers the connection — that is the driver's job at context
 * entry (request.tenant() / tenancy.run()). If a query reaches the adapter
 * with no connection registered (a cold worker, an LRU eviction, a custom
 * entry point that forgot to enter context), Lucid throws an opaque
 * "connection X is not registered" error. The robust fix asserts
 * db.manager.has(name) at the boundary and throws a typed, actionable
 * IsolationConfigException instead.
 *
 * RED (current code): the adapter calls db.connection(name) directly with no
 * precondition, so the raw Lucid error surfaces and it is NOT an
 * IsolationConfigException.
 */

const UUID1 = '11111111-1111-4111-8111-111111111111'

function makeRegistry() {
  const reg = new IsolationDriverRegistry()
  reg.register(new SchemaPgDriver())
  return reg
}

function makeRequest(headers: Record<string, string>) {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
  return {
    hostname: () => (h['host'] ?? '').split(':')[0],
    url: () => '/',
    header: (key: string) => h[key.toLowerCase()] ?? null,
  }
}

/**
 * A db double whose manager reports the resolved connection as NOT registered
 * and whose connection() throws the way Lucid does for an unmanaged name. The
 * fix must short-circuit on `manager.has(name) === false` BEFORE calling
 * connection(), so connection() here should never be reached once green.
 */
function makeUnregisteredDb() {
  const calls: string[] = []
  return {
    calls,
    manager: { has: (_name: string) => false },
    connection: (name?: string) => {
      calls.push(String(name))
      throw new Error(`E_UNMANAGED_DB_CONNECTION: connection "${String(name)}" is not registered`)
    },
  }
}

test.group('TenantAdapter — missing-connection precondition', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => ({ request: makeRequest({ 'x-tenant-id': UUID1 }) })
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  test('throws a typed IsolationConfigException (not the raw Lucid error) when the connection was never established', ({
    assert,
  }) => {
    const adapter = new TenantAdapter(makeUnregisteredDb() as any, makeRegistry())
    assert.throws(() => adapter.modelConstructorClient({} as any), IsolationConfigException as any)
  })

  test('the error names the tenant id and how to establish context, and never calls connection()', ({
    assert,
  }) => {
    const db = makeUnregisteredDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    let err: any
    try {
      adapter.modelConstructorClient({} as any)
    } catch (e) {
      err = e
    }

    assert.instanceOf(err, IsolationConfigException)
    assert.match(err.message, new RegExp(UUID1))
    assert.match(err.message, /tenancy\.run|request\.tenant/)
    assert.lengthOf(
      db.calls,
      0,
      'must fail closed before asking Lucid for the unregistered connection'
    )
  })
})
