import type { ApplicationService } from '@adonisjs/core/types'

/**
 * The minimal logger surface a boot diagnostic needs. Deliberately narrow so an
 * installer can be handed a plain object in a test and so the container `logger`
 * binding satisfies it structurally.
 */
export interface BootLogger {
  warn: (...args: any[]) => void
  debug: (...args: any[]) => void
}

/**
 * The shared context every installer phase receives. It carries the app plus the
 * two cross-cutting concerns the provider used to own inline:
 *
 *  - {@link InstallerContext.warnWhenBooted} defers a boot-time diagnostic to
 *    `app.booted()`, where the container logger is guaranteed to exist (provider
 *    boot() runs before the eager logger binding materializes).
 *  - {@link InstallerContext.addDisposer} registers a teardown that the provider
 *    runs LIFO in `shutdown()`. This generalizes the old `#disposers`
 *    registry (PLD-6): any installer that arms something in `ready()` captures its
 *    teardown here.
 *
 * The provider keeps ownership of WHICH lifecycle phase runs each installer and of
 * `container.make`; installers own only the wiring logic for their subsystem. Read
 * config the same way the phase needs it (`app.config.get('multitenancy')`, or
 * `getConfig()` once FoundationWiring has committed the singleton).
 */
export interface InstallerContext {
  readonly app: ApplicationService
  /** Defer a boot diagnostic to app.booted(), where the container logger exists. */
  warnWhenBooted(emit: (logger: BootLogger) => void): void
  /** Register a teardown to run LIFO in provider.shutdown() (ready()-armed wiring). */
  addDisposer(dispose: () => void | Promise<void>): void
}

/**
 * One subsystem's slice of the provider lifecycle. Every method is optional: a
 * register-only support plane (resilience, audit) implements just `register`, a
 * start-only surface (http extensions) just `start`.
 *
 * `register` is SYNCHRONOUS: AdonisJS runs provider `register()` synchronously
 * (as do @adonisjs/core's AppServiceProvider and @adonisjs/lucid's DatabaseServiceProvider),
 * and singleton factories are lazy, so there is nothing to await. The later phases
 * may be async. The provider iterates the installers in array order for
 * register/boot/start/ready; teardown for ready()-armed wiring flows back through
 * {@link InstallerContext.addDisposer} and runs LIFO in shutdown().
 */
export interface ProviderInstaller {
  readonly name: string
  register?(ctx: InstallerContext): void
  boot?(ctx: InstallerContext): void | Promise<void>
  start?(ctx: InstallerContext): void | Promise<void>
  ready?(ctx: InstallerContext): void | Promise<void>
}

/**
 * Build the shared {@link InstallerContext} for a provider instance. `warnWhenBooted`
 * closes over the app; `addDisposer` forwards to the provider's disposer registry so
 * shutdown() can run the teardowns LIFO.
 */
export function createInstallerContext(
  app: ApplicationService,
  addDisposer: (dispose: () => void | Promise<void>) => void
): InstallerContext {
  return {
    app,
    addDisposer,
    warnWhenBooted(emit: (logger: BootLogger) => void): void {
      void app.booted(async () => {
        try {
          const logger = (await app.container.make('logger')) as BootLogger
          emit(logger)
        } catch {
          // A boot diagnostic must never fail app startup. By app.booted the logger
          // is expected to resolve, so this only guards a pathological make()/emit
          // failure; swallow it rather than let it reject out of the booted-hook
          // runner and take the whole boot down over a warning.
        }
      })
    },
  }
}
