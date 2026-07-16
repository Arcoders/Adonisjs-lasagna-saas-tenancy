import app from '@adonisjs/core/services/app'
import CircuitBreakerService from '../../circuit_breaker_service.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * Doctor diagnostic check that inspects every tenant circuit breaker and reports those
 * currently in the OPEN state as error-severity issues, recording each breaker's failure
 * and success counts in the issue metadata. When the doctor run is invoked with the fix
 * flag, it resets each open breaker to close it again, marking the outcome of every reset
 * attempt in the issue meta.
 */
const circuitBreakerCheck: DoctorCheck = {
  name: 'circuit_breakers',
  description: 'Reports OPEN circuit breakers; with --fix, resets each one (closes it).',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const cb = await app.container.make(CircuitBreakerService)
    const metrics = cb.getAllMetrics()
    const issues: DiagnosisIssue[] = []

    for (const [tenantId, m] of Object.entries(metrics)) {
      if (m.state !== 'OPEN') continue
      issues.push({
        code: 'circuit_open',
        severity: 'error',
        message: `Circuit OPEN for tenant ${tenantId} (failures=${m.failures})`,
        tenantId,
        fixable: true,
        meta: { state: m.state, failures: m.failures, successes: m.successes },
      })
    }

    if (ctx.attemptFix && issues.length > 0) {
      for (const issue of issues) {
        if (!issue.tenantId) continue
        try {
          cb.reset(issue.tenantId)
          issue.meta = { ...(issue.meta ?? {}), fixed: true }
        } catch (error: any) {
          issue.meta = { ...(issue.meta ?? {}), fixed: false, fixError: error?.message }
        }
      }
    }

    return issues
  },
}

export default circuitBreakerCheck
