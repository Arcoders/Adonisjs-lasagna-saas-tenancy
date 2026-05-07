import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import HealthService from './health_service.js'
import { backofficeDbCheck, redisCheck, makeCircuitBreakerCheck } from './default_checks.js'
import { collectSnapshot } from './metrics_collector.js'
import { renderPrometheus } from './metrics_exporter.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'

let bootstrapped = false

async function bootstrapDefaultChecks(): Promise<HealthService> {
  const svc = await app.container.make(HealthService)
  if (bootstrapped) return svc

  if (!svc.hasCheck('backoffice_db')) svc.addCheck('backoffice_db', backofficeDbCheck)
  if (!svc.hasCheck('redis')) svc.addCheck('redis', redisCheck)
  if (!svc.hasCheck('circuit_breakers')) {
    svc.addCheck(
      'circuit_breakers',
      makeCircuitBreakerCheck(async () => {
        try {
          const cb = await app.container.make(CircuitBreakerService)
          return cb.getAllMetrics()
        } catch {
          return {}
        }
      })
    )
  }

  bootstrapped = true
  return svc
}

export default class HealthController {
  async livez({ response }: HttpContext) {
    const svc = await bootstrapDefaultChecks()
    return response.ok(svc.liveness())
  }

  async readyz({ response }: HttpContext) {
    const svc = await bootstrapDefaultChecks()
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
