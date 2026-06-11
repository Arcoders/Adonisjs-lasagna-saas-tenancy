import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import HealthService from './health_service.js'
import { collectSnapshot } from './metrics_collector.js'
import { renderPrometheus } from './metrics_exporter.js'

/**
 * The default check set (backoffice_db, redis, circuit_breakers) is
 * registered by the provider's `boot()` — see
 * `registerDefaultChecks()` in default_checks.ts. The controller is
 * stateless: it serves whatever the service holds at probe time, so a
 * host that overrode or removed a default never has it resurrected here.
 */
export default class HealthController {
  async livez({ response }: HttpContext) {
    const svc = await app.container.make(HealthService)
    return response.ok(svc.liveness())
  }

  async readyz({ response }: HttpContext) {
    const svc = await app.container.make(HealthService)
    const report = await svc.readiness()
    if (report.status === 'fail') return response.serviceUnavailable(report)
    return response.ok(report)
  }

  async healthz(ctx: HttpContext) {
    return this.readyz(ctx)
  }

  async metrics({ response }: HttpContext) {
    const snapshot = await collectSnapshot()
    response.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    return response.send(renderPrometheus(snapshot))
  }
}
