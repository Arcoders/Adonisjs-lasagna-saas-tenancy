import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { getActiveDriver, CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantSuspended, TenantDeleted } from '@adonisjs-lasagna/saas-tenancy/events'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  TenantModelContract,
  TenantRepositoryContract,
} from '@adonisjs-lasagna/saas-tenancy/types'
import TenantSocketServer from '../src/tenant_socket_server.js'
import { resolveTenantIdFromHandshake } from '../src/resolve_from_handshake.js'
import { assertWebSocketsConfig } from '../src/validate_config.js'
import { normalizeAuthorize } from '../src/resolve_authorize.js'
import type { MultitenancyConfigWithWebsockets } from '../src/define_config.js'
import type { IoServer, WebSocketsConfig } from '../src/types.js'

/**
 * Provider for `@adonisjs-lasagna/websockets`, built with the {@link definePlugin}
 * facade. Register it in `adonisrc.ts` alongside the core `MultitenancyProvider`
 * (the configure hook does that). It follows the platform rules: core never
 * imports this package; it self-wires against core's PUBLIC surfaces (`/services`,
 * never `/internal`), resolving core services via `app.container.make`.
 *
 *  - `bind`: bind the `TenantSocketServer` singleton.
 *  - `boot`: read and validate `config.multitenancy.websockets`, resolve the
 *    circuit breaker, and subscribe to the framework `http:server_ready` event so
 *    socket.io attaches the moment the HTTP server is listening (lazy-imported, so
 *    socket.io stays optional). ace/worker processes never emit that event, so WS
 *    stays off there automatically.
 *  - `shutdown`: drain the socket.io server.
 *
 * Why `http:server_ready` and not the provider `ready()` hook: `node ace serve`
 * emits `http:server_ready` from inside the app's start callback, which runs
 * *before* provider `ready()`, so a `ready()` attach would miss the node server
 * timing in some runners. Subscribing in `boot()` (which always runs before the
 * event) is the reliable hook across `serve`, the test runner, and workers.
 *
 * The socket.io attach state lives in provider-lifetime module variables below.
 * AdonisJS constructs exactly one provider per app, so these are equivalent to the
 * instance fields the raw provider used; the facade's hooks share them by closure.
 */
let wsConfig: WebSocketsConfig | undefined
let enabled = false
let breaker: CircuitBreakerService | undefined
let io: IoServer | undefined
let attaching = false

export default definePlugin({
  name: 'websockets',
  packageName: '@adonisjs-lasagna/websockets',
  // Mirrors package.json#lasagnaSatellite.satelliteApi.
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  bind(app) {
    app.container.singleton(TenantSocketServer, () => new TenantSocketServer(buildDeps(app)))
  },

  async boot(app) {
    const config = app.config.get<MultitenancyConfigWithWebsockets>('multitenancy')
    wsConfig = config?.websockets
    enabled = Boolean(wsConfig)
    if (!enabled) return

    // Eager validation so a bad shape fails at boot, not at the first upgrade.
    assertWebSocketsConfig(wsConfig!)

    breaker = await app.container.make(CircuitBreakerService)

    // Resolve the emitter from the container (not the `services/emitter` module,
    // which resolves too early to import during boot). `http:server_ready` fires
    // once the node HTTP server is listening (only in an HTTP process), so this
    // single code path covers serve and the test runner and never runs for the
    // ace/worker processes (which don't emit it).
    const emitter = await app.container.make('emitter')
    emitter.on('http:server_ready', () => {
      void attach(app)
    })
  },

  async shutdown() {
    if (!io) return
    await new Promise<void>((resolve) => {
      io!.close(() => resolve())
    }).catch(() => {})
  },
})

/**
 * Create the socket.io server on the live node HTTP server and wire isolation.
 * Idempotent and best-effort: a missing socket.io install logs and disables WS
 * rather than crashing the app.
 */
async function attach(app: ApplicationService): Promise<void> {
  // `io` is the permanent guard; `attaching` closes the async window between here
  // and setting `io`, so a second `http:server_ready` can't create a duplicate
  // socket.io server on the same node server.
  if (io || attaching || !enabled) return
  attaching = true
  try {
    const server: any = await app.container.make('server' as any)
    const node = server?.getNodeServer?.()
    if (!node) return

    let SocketIOServer: new (srv: unknown, opts?: unknown) => unknown
    try {
      ;({ Server: SocketIOServer } = await lazyImport('socket.io'))
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message },
        '[websockets] socket.io is not installed. WebSockets disabled. Run `npm i socket.io`.'
      )
      return
    }

    const ioServer = new SocketIOServer(node, {
      ...(wsConfig?.path ? { path: wsConfig.path } : {}),
      ...(wsConfig?.cors !== undefined ? { cors: wsConfig.cors } : {}),
    })
    io = ioServer as unknown as IoServer

    const socketServer = await app.container.make(TenantSocketServer)
    socketServer.attach(io)
    await wireLifecycle(app, socketServer)

    logger.info('[websockets] socket.io attached with per-tenant isolation')
  } finally {
    attaching = false
  }
}

function buildDeps(app: ApplicationService) {
  return {
    resolveTenantId: (handshake: Parameters<typeof resolveTenantIdFromHandshake>[0]) =>
      // Default the header source to core's configured `tenantHeaderKey` so WS
      // header resolution matches the HTTP `HeaderResolver`; an explicit
      // `websockets.handshake.headerKey` still overrides it. Read lazily (per
      // handshake) so it reflects the booted core config.
      resolveTenantIdFromHandshake(handshake, {
        headerKey: getConfig().tenantHeaderKey,
        ...(wsConfig?.handshake ?? {}),
      }),
    loadTenant: async (id: string) => {
      const repo = (await app.container.make(
        TENANT_REPOSITORY as never
      )) as TenantRepositoryContract
      return repo.findById(id, false)
    },
    assertServiceable: (tenant: TenantModelContract) => assertServiceable(tenant, breaker),
    connectTenant: async (tenant: TenantModelContract) => {
      const driver = await getActiveDriver()
      await driver.connect(tenant)
    },
    runAsTenant: <T>(tenant: TenantModelContract, fn: () => T | Promise<T>) =>
      tenancy.run(tenant, fn),
    currentTenantId: () => tenancy.currentId(),
    authorize: normalizeAuthorize(wsConfig?.authorize),
    logger,
  }
}

/**
 * Sever a tenant's live sockets when it is suspended or hard-deleted, so a
 * connection opened while the tenant was healthy can't keep streaming after.
 *
 * The AdonisJS emitter is in-process, so this fires only when the lifecycle
 * event is emitted in the same process that holds the sockets. A suspension
 * triggered from a worker/ace process or another HTTP node will NOT sever
 * sockets elsewhere; for multi-node severance, propagate the event over Redis
 * (e.g. a socket.io Redis adapter or pub-sub). See the cookbook.
 */
async function wireLifecycle(
  app: ApplicationService,
  socketServer: TenantSocketServer
): Promise<void> {
  const emitter = await app.container.make('emitter')
  emitter.on(TenantSuspended, (event) => socketServer.disconnectTenant(event.tenant.id))
  emitter.on(TenantDeleted, (event) => socketServer.disconnectTenant(event.tenant.id))
}

/**
 * Fail-closed serviceability check, mirroring `TenantGuardMiddleware`: a
 * suspended, deleted, or not-ready tenant, or one whose backend circuit is open,
 * must not open a socket. Throwing here rejects the upgrade.
 */
function assertServiceable(tenant: TenantModelContract, cb?: CircuitBreakerService): void {
  if (tenant.isDeleted || tenant.isSuspended) {
    throw unavailable('TENANT_SUSPENDED', 'Tenant is suspended or deleted')
  }
  if (tenant.isProvisioning || tenant.isFailed) {
    throw unavailable('TENANT_NOT_READY', 'Tenant is not ready')
  }
  if (cb?.isOpen(tenant.id)) {
    throw unavailable('CIRCUIT_OPEN', 'Tenant backend circuit is open')
  }
}

function unavailable(code: string, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { data?: unknown }).data = { code }
  return err
}

/**
 * Import a module by a specifier TypeScript must NOT resolve at build time, so
 * socket.io stays a genuine optional peer (mirrors core's transmit bootstrapper).
 */
function lazyImport(specifier: string): Promise<any> {
  return (Function('s', 'return import(s)') as (s: string) => Promise<any>)(specifier)
}
