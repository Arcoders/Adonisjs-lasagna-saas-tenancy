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

  /**
   * `ready` runs after `boot` (DB is up). The HTTP tier seeds tenants in a
   * separate process from the one that serves, so the spawned server must
   * re-register those tenant connections in its own Lucid manager before
   * requests can route to them. The HTTP harness passes the seeded ids via
   * `BENCH_WARM_TENANT_IDS`; the headless tiers (which don't set it) no-op.
   */
  async ready() {
    const raw = process.env.BENCH_WARM_TENANT_IDS
    if (!raw) return
    const ids = raw.split(',').filter(Boolean)
    if (ids.length === 0) return
    const { warmTenantConnections } = await import('../../../src/harness/provision.js')
    await warmTenantConnections(this.app, ids)
    // eslint-disable-next-line no-console
    console.log(`Warmed ${ids.length} tenant connections in the serve process.`)
  }
}
