import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import MissingTenantHeaderException from '../../../../src/exceptions/missing_tenant_header_exception.js'
import { __resetResolverRegistryCacheForTests } from '../../../../src/extensions/request.js'
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

  test('routes by tenancy.currentId() when it AGREES with the HTTP context (guarded-request path)', async ({
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

    // The normal guarded HTTP request: the guard resolved the SAME tenant the
    // request names, so both sources are present and agree.
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID2 } }),
    })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID2 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      adapter.modelConstructorClient({} as any)
    })

    assert.equal(db.lastCall, `tenant_${UUID2}`)
  })

  test('ContextSeal: fails closed when tenancy.currentId() and the HTTP context DISAGREE', async ({
    assert,
  }) => {
    // Pre-Isthmus, tenancy silently won this disagreement and routed tenant A
    // queries under tenant B's context, the exact context-confusion bug class
    // the ContextSeal exists to stop (the core isolation invariant).
    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default
    const { default: IsthmusTenantMismatchException } =
      await import('../../../../src/exceptions/isthmus_tenant_mismatch_exception.js')

    tenancyMod.__configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })

    // HTTP says one tenant, tenancy.run says another, so refuse to route.
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID2 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      assert.throws(
        () => adapter.modelConstructorClient({} as any),
        IsthmusTenantMismatchException as any
      )
    })

    assert.lengthOf(db.calls, 0, 'the mismatched query must never reach a connection')
  })

  test('ContextSeal: the HTTP comparand is resolved once per request (memoized)', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default

    tenancyMod.__configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })

    // One request object shared by every query in the request, counting reads.
    let headerReads = 0
    const request = {
      hostname: () => '',
      url: () => '/',
      header: (key: string) => {
        if (key.toLowerCase() === 'x-tenant-id') headerReads++
        return key.toLowerCase() === 'x-tenant-id' ? UUID2 : null
      },
    }
    ;(HttpContext as any).get = () => ({ request })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const fakeTenant = { id: UUID2 } as any
    await tenancyMod.tenancy.run(fakeTenant, async () => {
      adapter.modelConstructorClient({} as any)
      adapter.modelConstructorClient({} as any)
      adapter.modelConstructorClient({} as any)
    })

    assert.equal(headerReads, 1, 'the seal must not re-resolve the request on every query')
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
    // could land in the tenant schema, a cross-schema bug.
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

test.group('TenantAdapter — ContextSeal (Isthmus) deep behavior', (group) => {
  let originalGet: typeof HttpContext.get
  let captured: any[] = []

  group.each.setup(async () => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null

    const audit = await import('../../../../src/isthmus/audit.js')
    captured = []
    audit.__resetIsthmusCounters()
    audit.__resetIsthmusRateLimit()
    audit.__setIsthmusDispatcherForTests(async (payload) => {
      captured.push(payload)
    })

    const tenancyMod = await import('../../../../src/tenancy.js')
    const TenantLogContext = (await import('../../../../src/services/tenant_log_context.js'))
      .default
    const BootstrapperRegistry = (await import('../../../../src/services/bootstrapper_registry.js'))
      .default
    tenancyMod.__configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
  })

  group.each.teardown(async () => {
    ;(HttpContext as any).get = originalGet
    const audit = await import('../../../../src/isthmus/audit.js')
    audit.__setIsthmusDispatcherForTests(undefined)
    audit.__resetIsthmusCounters()
    audit.__resetIsthmusRateLimit()
    const tenancyMod = await import('../../../../src/tenancy.js')
    tenancyMod.__configureTenancyForTests({})
  })

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  test('nested scopes: inner run(B) inside an agreeing run(A) trips, naming the INNER id', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const { default: IsthmusTenantMismatchException } =
      await import('../../../../src/exceptions/isthmus_tenant_mismatch_exception.js')
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    await tenancyMod.tenancy.run({ id: UUID1 } as any, async () => {
      adapter.modelConstructorClient({} as any) // agrees, so routes
      assert.equal(db.lastCall, `tenant_${UUID1}`)
      await tenancyMod.tenancy.run({ id: UUID2 } as any, async () => {
        // Inner scope disagrees with the request (still UUID1), so it trips.
        let threw: any
        try {
          adapter.modelConstructorClient({} as any)
        } catch (err) {
          threw = err
        }
        assert.instanceOf(threw, IsthmusTenantMismatchException as any)
        // The exception's tenancy-scope id is the INNER scope (ALS nesting).
        assert.match(threw.message, new RegExp(UUID2))
        assert.match(threw.message, new RegExp(UUID1))
      })
    })
    await settle()
    // The emission names its registry id and event verbatim (this is also the
    // in-file assertion the emission matrix's viaIntegration check verifies for
    // 'seal.tenant_context').
    assert.equal(captured.at(-1).id, 'seal.tenant_context')
    assert.equal(captured.at(-1).event, 'isthmus:seal:tenant:mismatch')
    assert.equal(captured.at(-1).severity, 'critical')
    assert.equal(captured.at(-1).tenantId, UUID2)
    assert.equal(captured.at(-1).metadata.requestResolvedId, UUID1)
  })

  test('null comparand is not cached: a late request.tenant() memo is picked up', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const { __setMemoizedTenant } = await import('../../../../src/extensions/request.js')
    const { default: IsthmusTenantMismatchException } =
      await import('../../../../src/exceptions/isthmus_tenant_mismatch_exception.js')

    // A central-style request: no header, so the sync comparand is absent.
    const request: any = makeRequest({ headers: {} })
    ;(HttpContext as any).get = () => ({ request })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    await tenancyMod.tenancy.run({ id: UUID2 } as any, async () => {
      // Comparand null, so the seal is inert and routes by the scope.
      adapter.modelConstructorClient({} as any)
      assert.equal(db.lastCall, `tenant_${UUID2}`)

      // The guard memoizes a DIFFERENT tenant on the same request later.
      __setMemoizedTenant(request, { id: UUID1 } as any)
      assert.throws(
        () => adapter.modelConstructorClient({} as any),
        IsthmusTenantMismatchException as any
      )
    })
    await settle()
    assert.isAtLeast(captured.length, 1)
  })

  test('macro-first precedence: memoized tenant wins over the raw header', async ({ assert }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const { __setMemoizedTenant } = await import('../../../../src/extensions/request.js')

    // Header says A, but request.tenant() (domain resolution) memoized B, and
    // the scope is B, so the comparand is B, so it AGREES and routes B.
    const request: any = makeRequest({ headers: { 'x-tenant-id': UUID1 } })
    __setMemoizedTenant(request, { id: UUID2 } as any)
    ;(HttpContext as any).get = () => ({ request })

    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    await tenancyMod.tenancy.run({ id: UUID2 } as any, async () => {
      adapter.modelConstructorClient({} as any)
    })
    await settle()

    assert.equal(db.lastCall, `tenant_${UUID2}`)
    assert.lengthOf(captured, 0, 'the memoized id agrees with the scope → no mismatch')
  })

  test('exactly-once per query: 3 mismatched queries → 3 throws and 3 events', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    await tenancyMod.tenancy.run({ id: UUID2 } as any, async () => {
      for (let i = 0; i < 3; i++) {
        assert.throws(() => adapter.modelConstructorClient({} as any))
      }
    })
    await settle()

    // The memo caches the comparand, never the verdict. Every query re-checks.
    assert.lengthOf(captured, 3)
    assert.lengthOf(db.calls, 0)
  })

  test('memo isolation: an agreeing request and a mismatching request do not cross-contaminate', async ({
    assert,
  }) => {
    const tenancyMod = await import('../../../../src/tenancy.js')
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const agreeReq = makeRequest({ headers: { 'x-tenant-id': UUID2 } })
    const mismatchReq = makeRequest({ headers: { 'x-tenant-id': UUID1 } })

    await tenancyMod.tenancy.run({ id: UUID2 } as any, async () => {
      ;(HttpContext as any).get = () => ({ request: agreeReq })
      adapter.modelConstructorClient({} as any)
      assert.equal(db.lastCall, `tenant_${UUID2}`)
      ;(HttpContext as any).get = () => ({ request: mismatchReq })
      assert.throws(() => adapter.modelConstructorClient({} as any))

      // Back to the agreeing request: its memo is intact, still routes.
      ;(HttpContext as any).get = () => ({ request: agreeReq })
      adapter.modelConstructorClient({} as any)
      assert.equal(db.lastCall, `tenant_${UUID2}`)
    })
    await settle()
    assert.lengthOf(captured, 1, 'only the mismatching request emitted')
  })
})

test.group('TenantAdapter — model-query routing via the resolver chain (B1)', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    // Reset the module-level registry cache so the "no registry wired in" test
    // deterministically rebuilds the chain from config rather than reusing a chain
    // another spec seeded via setResolverRegistry.
    __resetResolverRegistryCacheForTests()
    originalGet = HttpContext.get
    ;(HttpContext as any).get = () => null
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
    __resetResolverRegistryCacheForTests()
  })

  // A custom resolver that reads a non-standard header and is registered in the
  // chain — the kind of resolver a plain `resolverStrategy` switch never knew about.
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

  test('routes a model query via the injected custom resolver chain', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-custom-tenant': UUID1 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry(), customChain())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID1}`,
      'the custom resolver in the chain must route the query'
    )
  })

  test('the custom resolver in the chain wins over the header strategy', ({ assert }) => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    // Both headers present: the chain consults the custom resolver
    // (x-custom-tenant), never a chain-blind resolverStrategy switch (x-tenant-id).
    ;(HttpContext as any).get = () => ({
      request: makeRequest({ headers: { 'x-tenant-id': UUID1, 'x-custom-tenant': UUID2 } }),
    })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry(), customChain())

    adapter.modelConstructorClient({} as any)

    assert.equal(
      db.lastCall,
      `tenant_${UUID2}`,
      'routing goes through the resolver chain, so the custom resolver wins'
    )
  })

  test('with no registry wired in, delegates to the module authority built from config', ({
    assert,
  }) => {
    // The adapter uses its injected registry when present; without one it delegates
    // to the module-level `resolveTenantId`, which builds the chain from config
    // (here a solitary `resolverStrategy: 'header'`) — one authority, no legacy switch.
    setConfig({ ...testConfig, resolverStrategy: 'header' })
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

    // No tenant id is extractable, and the synchronous adapter path can't
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
