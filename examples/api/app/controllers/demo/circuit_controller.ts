import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * Reads the circuit breaker state for the current tenant. Run this after a
 * burst of failed queries to see the breaker flip OPEN; wait `resetTimeout`
 * (30 s by default) to see HALF_OPEN, then CLOSED again on the next success.
 */
export default class CircuitController {
  async state({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const svc = await app.container.make(CircuitBreakerService)
    // Touch the connection so a breaker is materialised for this tenant.
    tenant.getConnection()
    return response.ok({ tenantId: tenant.id, metrics: svc.getMetrics(tenant.id) })
  }
}
