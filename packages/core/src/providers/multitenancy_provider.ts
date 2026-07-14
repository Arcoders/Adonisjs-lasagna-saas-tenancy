import type { ApplicationService } from '@adonisjs/core/types'
import { INSTALLERS, createInstallerContext, type InstallerContext } from './installers/index.js'

/**
 * The multitenancy provider is a thin orchestrator over an ordered array of
 * per-subsystem installers ({@link INSTALLERS}). Each installer owns its slice of
 * the AdonisJS lifecycle — the singleton registrations, the boot-time wiring, the
 * start-time asserts, the ready-time arming — so this class holds no subsystem
 * logic of its own. It iterates the installers in array order for
 * register/boot/start/ready, and generalizes the old `#disposers` registry (PLD-6)
 * via `ctx.addDisposer`, which shutdown() runs LIFO.
 *
 * This mirrors the native AdonisJS idiom (@adonisjs/core's AppServiceProvider runs
 * an ordered sequence of per-concern register methods; @adonisjs/lucid's provider
 * delegates to internal `src/bindings/` modules) and dogfoods the same
 * decomposition the package already ships as `definePlugin` for satellites.
 *
 * Billing (service, listeners, jobs, webhook route, drain) lives in
 * `@adonisjs-lasagna/billing`; its own provider wires those against core
 * events/hooks. The core provider no longer references billing.
 */
export default class MultitenancyProvider {
  /** Lifecycle disposers, torn down LIFO in shutdown(). Populated via ctx.addDisposer in ready(). */
  #disposers: Array<() => void | Promise<void>> = []
  readonly #ctx: InstallerContext

  constructor(protected app: ApplicationService) {
    this.#ctx = createInstallerContext(app, (dispose) => this.#disposers.push(dispose))
  }

  register() {
    // Synchronous, like the framework's own providers: singleton factories are lazy.
    for (const installer of INSTALLERS) installer.register?.(this.#ctx)
  }

  async boot() {
    // Sequential (not Promise.all): FoundationWiring must commit the config
    // singleton before any later installer reads getConfig(), and the array order
    // encodes the remaining boot dependencies.
    for (const installer of INSTALLERS) await installer.boot?.(this.#ctx)
  }

  async start() {
    for (const installer of INSTALLERS) await installer.start?.(this.#ctx)
  }

  async ready() {
    for (const installer of INSTALLERS) await installer.ready?.(this.#ctx)
  }

  /**
   * Graceful teardown on `app.terminate()` (the SIGTERM path in worker/web
   * processes). Three steps, in order:
   *
   * 1. Run the lifecycle disposers registered during ready() in reverse (LIFO),
   *    chiefly the resolution-cache-invalidation listeners, so our emitter
   *    subscriptions are detached before the singletons they reference are torn
   *    down.
   * 2. Close the long-lived libuv handles our singletons own (see
   *    {@link closeOwnedHandles}) — chiefly `TenantQueueService`'s per-tenant
   *    BullMQ queues, whose ioredis sockets would otherwise keep the event loop
   *    alive after terminate() and hang the process until SIGKILL.
   * 3. Invalidate module-level caches that hold references to container
   *    singletons (see {@link resetModuleCaches} for the why).
   *
   * Handles before caches: dropping the module-cache references before releasing
   * the sockets would orphan the very services that still own them. The billing
   * metering drain moved to the @adonisjs-lasagna/billing provider's shutdown.
   */
  async shutdown() {
    // LIFO teardown of what ready() wired (the cache-invalidation listeners),
    // before the singletons they close over are released below. Each disposer is
    // isolated: a throwing one must never skip closeOwnedHandles, which drains the
    // BullMQ sockets that otherwise keep the event loop alive and hang SIGTERM.
    for (const dispose of this.#disposers.reverse()) {
      try {
        await dispose()
      } catch (error) {
        const logger = await this.app.container.make('logger').catch(() => undefined)
        logger?.warn(
          { err: (error as Error)?.message },
          '[multitenancy] a shutdown disposer threw; continuing teardown'
        )
      }
    }
    this.#disposers = []

    const { closeOwnedHandles } = await import('./shutdown_handles.js')
    await closeOwnedHandles(this.app)

    const { resetModuleCaches } = await import('./shutdown_caches.js')
    await resetModuleCaches()
  }
}
