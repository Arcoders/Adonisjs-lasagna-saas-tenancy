import type { ApplicationService } from '@adonisjs/core/types'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import TenantRepository from '../repositories/tenant_repository.js'

/**
 * Binds the host-app contracts the package needs: the tenant repository (the
 * package never imports a Tenant model directly) and a CircuitBreakerService
 * singleton. Same shape as the core test fixture's provider, minus the
 * satellite wiring.
 */
export default class BenchProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    this.app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())
    this.app.container.singleton(CircuitBreakerService, () => new CircuitBreakerService())
  }
}
