import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import MissingTenantHeaderException from '../../../../src/exceptions/missing_tenant_header_exception.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import { ResolverHit } from '../../../../src/services/resolvers/resolver.js'

function makeRegistry() {
  const reg = new IsolationDriverRegistry()
  reg.register(new SchemaPgDriver())
  return reg
}

// Valid v4 UUIDs for use in tests
const UUID1 = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const UUID3 = '33333333-3333-4333-8333-333333333333'

function makeRequest(opts: { headers?: Record<string, string>; url?: string } = {}) {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v
  }
  return {
    hostname: () => (headers['host'] ?? '').split(':')[0],
    url: () => (opts.url ?? '/').split('?')[0],
    header: (key: string) => headers[key.toLowerCase()] ?? null,
  }
}

function makeMockDb() {
  const calls: string[] = []
  const db = {
    connection: (name?: string) => {
      calls.push(name ?? '__undefined__')
      return `client:${String(name)}`
    },
    get lastCall() {
      return calls[calls.length - 1]
    },
    calls,
  }
  return db
}

test.group('TenantAdapter — modelConstructorClient', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  test('returns options.client directly when provided', ({ assert }) => {
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())
    const client = { isClient: true }

    const result = adapter.modelConstructorClient({} as any, { client: client as any })

    assert.strictEqual(result, client)
    assert.lengthOf(db.calls, 0)
  })

  test('uses model connection when no HTTP context is active', ({ assert }) => {
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({ connection: 'public' } as any)

    assert.equal(db.lastCall, 'public')
  })

  test('uses options.connection over model connection when no context', ({ assert }) => {
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({ connection: 'public' } as any, { connection: 'override_conn' })

    assert.equal(db.lastCall, 'override_conn')
  })

  test('header strategy builds tenant connection from UUID in configured header', ({ assert }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `tenant_${UUID1}`)
  })

  test('respects custom tenantHeaderKey from config', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantHeaderKey: 'x-workspace-id' })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-workspace-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `tenant_${UUID1}`)
  })

  test('subdomain strategy extracts UUID from hostname', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'subdomain', baseDomain: 'example.com' })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { host: `${UUID2}.example.com` } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `tenant_${UUID2}`)
  })

  test('path strategy extracts UUID from first URL segment', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'path' })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ url: `/${UUID3}/api/users` }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `tenant_${UUID3}`)
  })

  test('uses tenantConnectionNamePrefix from config', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header', tenantConnectionNamePrefix: 'org_' })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `org_${UUID1}`)
  })

  test('options.connection overrides the resolved tenant connection when context exists', ({
    assert,
  }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any, { connection: 'explicit_conn' })

    assert.equal(db.lastCall, 'explicit_conn')
  })

  test('throws MissingTenantHeaderException when tenant ID header is absent', ({ assert }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: {} }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    assert.throws(
      () => adapter.modelConstructorClient({} as any),
      MissingTenantHeaderException as any
    )
  })

  test('throws MissingTenantHeaderException when tenant ID is not a valid v4 UUID', ({
    assert,
  }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': 'not-a-uuid' } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    assert.throws(
      () => adapter.modelConstructorClient({} as any),
      MissingTenantHeaderException as any
    )
  })

  test('throws for a v3 UUID (wrong version bit)', ({ assert }) => {
    const uuidV3 = '11111111-1111-3111-8111-111111111111'
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': uuidV3 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    assert.throws(
      () => adapter.modelConstructorClient({} as any),
      MissingTenantHeaderException as any
    )
  })
})

test.group('TenantAdapter — tenancy.run() integration', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null
  })

  group.each.teardown(async () => {
    ;(HttpContext as any).get = originalGet
    const tenancyMod = await import('../../../../src/tenancy.js')
    tenancyMod.__configureTenancyForTests({})
  })

  test('prefers tenancy.currentId() over HTTP context when both are present', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default

    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    tenancyMod.__configureTenancyForTests({ logCtx, registry })

    // HTTP says one tenant, tenancy.run says another — tenancy wins.
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID2 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      adapter.modelConstructorClient({} as any)
    })

    assert.equal(db.lastCall, `tenant_${UUID2}`)
  })

  test('uses tenancy.currentId() with no HTTP context (queue/script path)', async ({ assert }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default

    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    tenancyMod.__configureTenancyForTests({ logCtx, registry })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID3 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      adapter.modelConstructorClient({} as any)
    })

    assert.equal(db.lastCall, `tenant_${UUID3}`)
  })

  test('options.connection wins over tenancy.run() — explicit beats scope', async ({ assert }) => {
    // Documents the contract: a model query that explicitly names a
    // connection (typically `central`/`backoffice`) must NOT be
    // silently rerouted to whatever tenant scope happens to be active.
    // Without this, a CentralBaseModel query inside `tenancy.run(t, ...)`
    // could land in the tenant schema — a cross-schema bug.
    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default

    tenancyMod.__configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID1 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      adapter.modelConstructorClient({} as any, { connection: 'backoffice' })
    })

    assert.equal(
      db.lastCall,
      'backoffice',
      'explicit options.connection MUST override the active tenancy scope'
    )
  })
})

test.group('TenantAdapter — legacyAdapterFallback flag (B1)', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  // A custom resolver that reads a non-standard header and is registered in the
  // chain. The legacy strategy switch never knows about it.
  function customChain() {
    const reg = new TenantResolverRegistry()
    reg.register({
      name: 'custom-header',
      contractVersion: 1,
      resolve: (request: any) => {
        const v = request.header('x-custom-tenant')
        return v ? ResolverHit.id(v) : ResolverHit.miss()
      },
    })
    reg.setChain(['custom-header'])
    return reg
  }

  test('legacyAdapterFallback:false routes a model query via the custom resolver chain', ({
    assert,
  }) => {
    setConfig({
      ...testConfig,
      resolverStrategy: 'header',
      resolver: { legacyAdapterFallback: false },
    })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-custom-tenant': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry(), customChain())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID1}`,
      'with the flag off, the custom resolver in the chain must route the query'
    )
  })

  test('legacyAdapterFallback:true (opt-in) ignores the custom chain and uses resolverStrategy', ({
    assert,
  }) => {
    setConfig({
      ...testConfig,
      resolverStrategy: 'header',
      resolver: { legacyAdapterFallback: true },
    })
    // Both headers present: legacy reads x-tenant-id, the custom chain would
    // read x-custom-tenant. The legacy id must win.
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1, 'x-custom-tenant': UUID2 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry(), customChain())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID1}`,
      'the historical path must keep using resolverStrategy, not the custom chain'
    )
  })

  test('no resolver block uses the unified chain (flag defaults to false in 1.0)', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    // Both headers present: the 1.0 default consults the custom chain
    // (x-custom-tenant), not the legacy resolverStrategy switch (x-tenant-id).
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1, 'x-custom-tenant': UUID2 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry(), customChain())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID2}`,
      'the 1.0 default routes via the resolver chain, so the custom resolver wins'
    )
  })

  test('legacyAdapterFallback:false with no resolvers passed falls back to legacy resolution', ({
    assert,
  }) => {
    // Defensive: the adapter only consults the chain when a registry was wired
    // in. Without one, it must still resolve via the legacy strategy.
    setConfig({
      ...testConfig,
      resolverStrategy: 'header',
      resolver: { legacyAdapterFallback: false },
    })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(db.lastCall, `tenant_${UUID1}`)
  })
})

test.group('TenantAdapter — domain-or-subdomain resolver strategy', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({
      ...testConfig,
      resolverStrategy: 'domain-or-subdomain',
      baseDomain: 'example.com',
    })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  test('falls back to subdomain extraction under domain-or-subdomain', ({ assert }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { host: `${UUID1}.example.com` } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID1}`,
      'a UUID-shaped subdomain of baseDomain should still resolve as a tenant'
    )
  })

  test('throws when host is exactly baseDomain (no subdomain, no domain)', ({ assert }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { host: 'example.com' } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    // No tenant id is extractable — the synchronous adapter path can't
    // do the async findByDomain lookup, so the request must fail closed.
    assert.throws(
      () => adapter.modelConstructorClient({} as any),
      MissingTenantHeaderException as any
    )
  })

  test('rejects a non-UUID subdomain (would otherwise be treated as a tenant id)', ({ assert }) => {
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { host: 'acme.example.com' } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    assert.throws(
      () => adapter.modelConstructorClient({} as any),
      MissingTenantHeaderException as any
    )
  })
})
