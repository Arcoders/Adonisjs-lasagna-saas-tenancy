import type { ApplicationService } from '@adonisjs/core/types'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  CircuitBreakerService,
  DoctorService,
  builtInChecks,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import TenantRepository from '#app/repositories/tenant_repository'

export default class AppProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    this.bindContainerServices()
  }

  /**
   * `ready` runs after `boot`, so the emitter (resolved via `app.booted()`
   * in `@adonisjs/core/services/emitter`) is guaranteed to exist by now.
   * Registering listeners earlier would crash with "cannot read 'on' of
   * undefined".
   */
  async ready() {
    await this.registerListeners()
  }

  /**
   * Repository contract + singletons the package looks up at runtime.
   *
   * - `TENANT_REPOSITORY` is required for `request.tenant()` and the package's
   *   own services (admin controller, doctor checks, etc.).
   * - `CircuitBreakerService` must be a singleton so the same breaker is
   *   reused across requests for the same tenant.
   * - `DoctorService` is a singleton with the 7 built-in checks plus a
   *   demo-only marker check that proves custom checks are pluggable.
   */
  private bindContainerServices() {
    // The TENANT_REPOSITORY symbol is typed as `unique symbol` by the package
    // but the container's `bind` overloads accept untyped Symbol values via
    // its any-keyed overload — cast at the binding site only.
    this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())

    this.app.container.singleton(
      CircuitBreakerService,
      () => new CircuitBreakerService()
    )

    this.app.container.singleton(DoctorService, () => {
      const svc = new DoctorService()
      for (const check of builtInChecks) svc.register(check)
      svc.register({
        name: 'demo_marker_check',
        description: 'Demo-only check that always succeeds — proves custom checks work.',
        async run(): Promise<DiagnosisIssue[]> {
          return [
            {
              code: 'demo_marker',
              severity: 'info',
              message: 'Demo check ran. All good.',
            },
          ]
        },
      })
      return svc
    })
  }

  /**
   * Wire app-side listeners onto the emitter. Lifted from `start/routes.ts`
   * so routing concerns stay decoupled from side-effects. We resolve the
   * emitter from the container (rather than importing the magic singleton)
   * to keep the lifecycle ordering explicit.
   */
  private async registerListeners() {
    const emitter = await this.app.container.make('emitter')
    const [
      { default: AuditListener },
      { default: TenantWelcomeListener },
    ] = await Promise.all([
      import('#app/listeners/audit_listener'),
      import('#app/listeners/tenant_welcome_listener'),
    ])
    AuditListener.register(emitter)
    TenantWelcomeListener.register(emitter)
  }
}
