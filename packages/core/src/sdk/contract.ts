import type { ApplicationService } from '@adonisjs/core/types'

/**
 * The lifecycle contract a packaged satellite's AdonisJS provider satisfies.
 * This is the formalization of what the first-party satellites
 * (`@adonisjs-lasagna/billing`, `/backup`, …) already do: a provider that
 * self-registers its services, listeners, jobs, and checks into the core
 * registries — while obeying the one hard rule of the platform:
 *
 *   > **Core never imports a satellite.** A satellite depends on core; if core
 *   > imported it back, that is a build cycle. Satellites self-register against
 *   > core's public registries (`HookRegistry`, `DoctorService`,
 *   > `IsolationDriverRegistry`, the `@adonisjs/queue` `Locator`, the emitter)
 *   > instead of being wired by core.
 *
 * Every method is optional and async-capable — implement only the phases you
 * need. The shape matches the AdonisJS provider lifecycle, so a satellite
 * provider is registered in `adonisrc.ts` like any other provider.
 *
 * Conventions (enforced for the first-party packages, recommended for all):
 *  - Resolve core services through `app.container.make(...)`, never `new` them.
 *  - `register()` binds your own singletons.
 *  - `boot()` validates config eagerly and registers checks/drivers into core
 *    registries (e.g. `DoctorService.register`, `BillingDriverRegistry.register`).
 *  - `start()` wires event/hook listeners and registers jobs with the queue
 *    `Locator`.
 *  - `shutdown()` drains anything in-flight; keep it best-effort.
 */
export interface SatelliteProviderContract {
  register?(): void | Promise<void>
  boot?(): void | Promise<void>
  start?(): void | Promise<void>
  ready?(): void | Promise<void>
  shutdown?(): void | Promise<void>
}

/**
 * The constructor shape AdonisJS calls a provider with. A satellite provider is
 * `class FooProvider implements SatelliteProviderContract { constructor(app) {} }`.
 */
export type SatelliteProviderConstructor = new (
  app: ApplicationService
) => SatelliteProviderContract
