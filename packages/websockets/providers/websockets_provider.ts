import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/internal'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantSuspended, TenantDeleted } from '@adonisjs-lasagna/saas-tenancy/events'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  MultitenancyConfig,
  TenantModelContract,
  TenantRepositoryContract,
} from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  SatelliteProviderConstructor,
  SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import TenantSocketServer from '../src/tenant_socket_server.js'
import { resolveTenantIdFromHandshake } from '../src/resolve_from_handshake.js'
import { assertWebSocketsConfig } from '../src/validate_config.js'
import type { IoServer, WebSocketsConfig } from '../src/types.js'

/** Config shape read off `config/multitenancy.ts` without augmenting core. */
type MultitenancyConfigWithWs = MultitenancyConfig & { websockets?: WebSocketsConfig }

/**
 * Provider for `@adonisjs-lasagna/websockets`. Register it in `adonisrc.ts`
 * alongside the core `MultitenancyProvider` (the configure hook does that). It
 * follows the platform rules: core never imports this package; it self-wires
 * against core's public surfaces, resolving core services via
 * `app.container.make`.
 *
 *  - `register()`: bind the `TenantSocketServer` singleton.
 *  - `boot()`: read and validate `config.multitenancy.websockets`, resolve the
 *                   circuit breaker, and subscribe to the framework
 *                   `http:server_ready` event so socket.io attaches the moment the
 *                   HTTP server is listening (lazy-imported, so socket.io stays
 *                   optional). ace/worker processes never emit that event, so WS
 *                   stays off there automatically.
 *  - `shutdown()`: drain the socket.io server.
 *
 * Why `http:server_ready` and not the provider `ready()` hook: `node ace serve`
 * emits `http:server_ready` from inside the app's start callback, which runs
 * *before* provider `ready()`, so a `ready()` attach would miss the node server
 * timing in some runners. Subscribing in `boot()` (which always runs before the
 * event) is the reliable hook across `serve`, the test runner, and workers.
 */
export default class WebSocketsProvider implements SatelliteProviderContract {
  #config?: WebSocketsConfig
  #enabled = false
  #cb?: CircuitBreakerService
  #io?: IoServer
  #attaching = false

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(
      TenantSocketServer,
      () => new TenantSocketServer(this.#buildDeps())
    )
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfigWithWs>('multitenancy')
    this.#config = config?.websockets
    this.#enabled = Boolean(this.#config)
    if (!this.#enabled) return

    // Eager validation so a bad shape fails at boot, not at the first upgrade.
    assertWebSocketsConfig(this.#config!)

    this.#cb = await this.app.container.make(CircuitBreakerService)

    // Resolve the emitter from the container (not the `services/emitter` module,
    // which resolves too early to import during boot). `http:server_ready` fires
    // once the node HTTP server is listening (only in an HTTP process), so this
    // single code path covers serve and the test runner and never runs for the
    // ace/worker processes (which don't emit it).
    const emitter = await this.app.container.make('emitter')
    emitter.on('http:server_ready', () => {
      void this.#attach()
    })
  }

  /**
   * Create the socket.io server on the live node HTTP server and wire isolation.
   * Idempotent and best-effort: a missing socket.io install logs and disables WS
   * rather than crashing the app.
   */
  async #attach(): Promise<void> {
    // `this.#io` is the permanent guard; `#attaching` closes the async window
    // between here and setting `#io`, so a second `http:server_ready` can't
    // create a duplicate socket.io server on the same node server.
    if (this.#io || this.#attaching || !this.#enabled) return
    this.#attaching = true
    try {
      const server: any = await this.app.container.make('server' as any)
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

      const io = new SocketIOServer(node, {
        ...(this.#config?.path ? { path: this.#config.path } : {}),
        ...(this.#config?.cors !== undefined ? { cors: this.#config.cors } : {}),
      })
      this.#io = io as unknown as IoServer

      const socketServer = await this.app.container.make(TenantSocketServer)
      socketServer.attach(this.#io)
      await this.#wireLifecycle(socketServer)

      logger.info('[websockets] socket.io attached with per-tenant isolation')
    } finally {
      this.#attaching = false
    }
  }

  async shutdown() {
    if (!this.#io) return
    await new Promise<void>((resolve) => {
      this.#io!.close(() => resolve())
    }).catch(() => {})
  }

  #buildDeps() {
    const app = this.app
    return {
      resolveTenantId: (handshake: Parameters<typeof resolveTenantIdFromHandshake>[0]) =>
        // Default the header source to core's configured `tenantHeaderKey` so WS
        // header resolution matches the HTTP `HeaderResolver`; an explicit
        // `websockets.handshake.headerKey` still overrides it. Read lazily (per
        // handshake) so it reflects the booted core config.
        resolveTenantIdFromHandshake(handshake, {
          headerKey: getConfig().tenantHeaderKey,
          ...(this.#config?.handshake ?? {}),
        }),
      loadTenant: async (id: string) => {
        const repo = (await app.container.make(
          TENANT_REPOSITORY as never
        )) as TenantRepositoryContract
        return repo.findById(id, false)
      },
      assertServiceable: (tenant: TenantModelContract) => assertServiceable(tenant, this.#cb),
      connectTenant: async (tenant: TenantModelContract) => {
        const driver = await getActiveDriver()
        await driver.connect(tenant)
      },
      runAsTenant: <T>(tenant: TenantModelContract, fn: () => T | Promise<T>) =>
        tenancy.run(tenant, fn),
      currentTenantId: () => tenancy.currentId(),
      authorize: this.#config?.authorize,
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
  async #wireLifecycle(socketServer: TenantSocketServer): Promise<void> {
    const emitter = await this.app.container.make('emitter')
    emitter.on(TenantSuspended, (event) => socketServer.disconnectTenant(event.tenant.id))
    emitter.on(TenantDeleted, (event) => socketServer.disconnectTenant(event.tenant.id))
  }
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

// Compile-time ABI pin: this provider's constructor AND instance must stay
// assignable to the published Satellite contract. Any lifecycle-signature drift
// fails `tsc` here (and at the `implements` clause), so a first-party provider
// can never silently diverge from the ABI third-party satellites build against.
// Runtime effect: a harmless no-op module-local, evaluated once at boot.
const _satelliteAbiPin: SatelliteProviderConstructor = WebSocketsProvider
