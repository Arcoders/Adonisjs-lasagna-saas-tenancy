import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { currentTenant } from '#app/helpers/current_tenant'

/**
 * Reads the circuit breaker state for the current tenant. Run this after a
 * burst of failed queries to see the breaker flip OPEN; wait `resetTimeout`
 * (30 s by default) to see HALF_OPEN, then CLOSED again on the next success.
 */
@inject()
export default class CircuitController {
  constructor(private readonly circuit: CircuitBreakerService) {}

  async state({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    // Touch the connection so a breaker is materialised for this tenant.
    tenant.getConnection()
    return response.ok({ tenantId: tenant.id, metrics: this.circuit.getMetrics(tenant.id) })
  }
}
