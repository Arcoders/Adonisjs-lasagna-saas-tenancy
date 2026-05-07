import type { CircuitMetrics } from '../services/circuit_breaker_service.js'
import type { TenantQueueStats } from '../services/tenant_queue_service.js'

export interface MetricsSnapshot {
  tenantsTotal: number
  tenantsByStatus: Record<string, number>
  circuits: Record<string, CircuitMetrics>
  queues: TenantQueueStats[]
  uptimeSeconds: number
}

const CIRCUIT_STATE_VALUE: Record<string, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 }

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function formatLabels(labels: Record<string, string | number>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ''
  const parts = entries.map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
  return `{${parts.join(',')}}`
}

function metricLine(
  name: string,
  labels: Record<string, string | number>,
  value: number
): string {
  return `${name}${formatLabels(labels)} ${Number.isFinite(value) ? value : 0}`
}

/**
 * Renders a Prometheus text-exposition snapshot. No external deps.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = []

  lines.push('# HELP multitenancy_tenants_total Total tenants registered (excluding hard-deleted).')
  lines.push('# TYPE multitenancy_tenants_total gauge')
  lines.push(metricLine('multitenancy_tenants_total', {}, snapshot.tenantsTotal))

  lines.push('# HELP multitenancy_tenants_by_status Tenants partitioned by status.')
  lines.push('# TYPE multitenancy_tenants_by_status gauge')
  for (const [status, count] of Object.entries(snapshot.tenantsByStatus)) {
    lines.push(metricLine('multitenancy_tenants_by_status', { status }, count))
  }

  lines.push('# HELP multitenancy_circuit_state Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN).')
  lines.push('# TYPE multitenancy_circuit_state gauge')
  lines.push('# HELP multitenancy_circuit_failures_total Failed calls observed by the circuit.')
  lines.push('# TYPE multitenancy_circuit_failures_total counter')
  lines.push('# HELP multitenancy_circuit_successes_total Successful calls observed by the circuit.')
  lines.push('# TYPE multitenancy_circuit_successes_total counter')
  for (const [tenantId, m] of Object.entries(snapshot.circuits)) {
    const labels = { tenant_id: tenantId }
    lines.push(metricLine('multitenancy_circuit_state', labels, CIRCUIT_STATE_VALUE[m.state] ?? 0))
    lines.push(metricLine('multitenancy_circuit_failures_total', labels, m.failures))
    lines.push(metricLine('multitenancy_circuit_successes_total', labels, m.successes))
  }

  lines.push('# HELP multitenancy_queue_jobs Number of jobs in a tenant queue partitioned by state.')
  lines.push('# TYPE multitenancy_queue_jobs gauge')
  for (const q of snapshot.queues) {
    const labels = { tenant_id: q.tenantId, queue: q.queueName }
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'waiting' }, q.waiting))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'active' }, q.active))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'completed' }, q.completed))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'failed' }, q.failed))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'delayed' }, q.delayed))
  }

  lines.push('# HELP multitenancy_uptime_seconds Process uptime in seconds.')
  lines.push('# TYPE multitenancy_uptime_seconds gauge')
  lines.push(metricLine('multitenancy_uptime_seconds', {}, snapshot.uptimeSeconds))

  return lines.join('\n') + '\n'
}
