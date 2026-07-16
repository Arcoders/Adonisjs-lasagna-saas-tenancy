import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import { pluginScope } from '../../../../src/services/plugin_execution_scope.js'
import {
  buildReadOnlyConnectionConfig,
  READ_ONLY_CONNECTION_SUFFIX,
} from '../../../../src/services/plugin_read_only_connection.js'
import { pluginName } from '../../../../src/sdk/brands.js'

/**
 * The read-only firewall. When UNTRUSTED plugin code is on the stack and a
 * read-only role is configured, the tenant adapter routes the query to a
 * connection cloned from the tenant's own (same schema/search_path) but
 * authenticated as the SELECT-only role, so Postgres denies a write. Core code
 * and trusted plugins keep the normal connection. (The end-to-end "Postgres
 * denies the DELETE" proof is the integration red-team; this pins the routing +
 * the clone that make it possible, without a live database.)
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

/** The tenant schema the primary is pinned to, as the driver derives it. */
function schemaFor(tenantId: string): string {
  return new SchemaPgDriver().schemaName(tenantId)
}

/** A db double whose manager has the primary registered and supports get/add. */
function makeDb(primaryName: string) {
  const added: Record<string, any> = {}
  const registered = new Set<string>([primaryName])
  const primaryConfig = {
    client: 'pg',
    // Pinned to THIS tenant's schema, as connect() registers it — the driver seals
    // the primary against the tenant before cloning it read-only.
    searchPath: [schemaFor(UUID1)],
    connection: { host: 'db', user: 'app', password: 'app-secret' },
  }
  return {
    added,
    manager: {
      has: (n: string) => registered.has(n),
      get: (n: string) => (n === primaryName ? { config: primaryConfig } : { config: added[n] }),
      add: (n: string, cfg: any) => {
        added[n] = cfg
        registered.add(n)
      },
    },
    connection: (name: string) => ({ name, modelQuery: () => ({}) }),
  }
}

const untrusted = { plugin: pluginName('sketchy'), trusted: false }
const trusted = { plugin: pluginName('reporting'), trusted: true }

test.group('buildReadOnlyConnectionConfig', () => {
  test('overrides only the credentials, preserving top-level searchPath + client', ({ assert }) => {
    const primary = {
      client: 'pg',
      searchPath: ['tenant_abc'],
      pool: { min: 0, max: 5 },
      connection: { host: 'db', user: 'app', password: 'app-secret', database: 't' },
    }
    const ro = buildReadOnlyConnectionConfig(primary, { user: 'plugin_ro', password: 'ro-secret' })
    assert.deepEqual(ro.searchPath, ['tenant_abc'])
    assert.deepEqual(ro.pool, { min: 0, max: 5 })
    assert.equal(ro.client, 'pg')
    assert.deepEqual(ro.connection, {
      host: 'db',
      user: 'plugin_ro',
      password: 'ro-secret',
      database: 't',
    })
  })

  test('falls back to the primary password + client=pg when omitted', ({ assert }) => {
    const ro = buildReadOnlyConnectionConfig(
      { connection: { host: 'db', user: 'app', password: 'keep' } },
      { user: 'plugin_ro' }
    )
    assert.equal((ro.connection as any).password, 'keep')
    assert.equal(ro.client, 'pg')
  })
})

test.group('TenantAdapter — read-only routing (S3)', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({
      ...testConfig,
      resolverStrategy: 'header',
      plugins: { readOnly: { user: 'plugin_ro', password: 'ro-secret' } },
    })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => ({ request: makeRequest({ 'x-tenant-id': UUID1 }) })
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  test('routes an untrusted plugin to the cloned read-only connection', ({ assert }) => {
    const registry = makeRegistry()
    const primaryName = registry.active().connectionName(UUID1)
    const db = makeDb(primaryName)
    const adapter = new TenantAdapter(db as any, registry)

    const client = pluginScope.run(untrusted, () => adapter.modelConstructorClient({} as any))

    const roName = primaryName + READ_ONLY_CONNECTION_SUFFIX
    assert.equal((client as any).name, roName)
    assert.property(db.added, roName)
    assert.equal(db.added[roName].connection.user, 'plugin_ro')
    assert.deepEqual(db.added[roName].searchPath, [schemaFor(UUID1)]) // preserved from the primary
  })

  test('reuses the read-only connection on a second untrusted query (registers once)', ({
    assert,
  }) => {
    const registry = makeRegistry()
    const primaryName = registry.active().connectionName(UUID1)
    const db = makeDb(primaryName)
    let adds = 0
    const origAdd = db.manager.add
    db.manager.add = (n: string, c: any) => {
      adds++
      origAdd(n, c)
    }
    const adapter = new TenantAdapter(db as any, registry)
    pluginScope.run(untrusted, () => {
      adapter.modelConstructorClient({} as any)
      adapter.modelConstructorClient({} as any)
    })
    assert.equal(adds, 1)
  })

  test('core code (no plugin scope) uses the normal connection', ({ assert }) => {
    const registry = makeRegistry()
    const primaryName = registry.active().connectionName(UUID1)
    const db = makeDb(primaryName)
    const adapter = new TenantAdapter(db as any, registry)
    const client = adapter.modelConstructorClient({} as any)
    assert.equal((client as any).name, primaryName)
    assert.notProperty(db.added, primaryName + READ_ONLY_CONNECTION_SUFFIX)
  })

  test('a TRUSTED plugin uses the normal connection', ({ assert }) => {
    const registry = makeRegistry()
    const primaryName = registry.active().connectionName(UUID1)
    const db = makeDb(primaryName)
    const adapter = new TenantAdapter(db as any, registry)
    const client = pluginScope.run(trusted, () => adapter.modelConstructorClient({} as any))
    assert.equal((client as any).name, primaryName)
  })

  test('with no readOnly config, an untrusted plugin still uses the normal connection', ({
    assert,
  }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header' }) // no plugins.readOnly
    const registry = makeRegistry()
    const primaryName = registry.active().connectionName(UUID1)
    const db = makeDb(primaryName)
    const adapter = new TenantAdapter(db as any, registry)
    const client = pluginScope.run(untrusted, () => adapter.modelConstructorClient({} as any))
    assert.equal((client as any).name, primaryName)
  })
})
