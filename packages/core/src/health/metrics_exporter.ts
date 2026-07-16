import type { CircuitMetrics } from '../services/circuit_breaker_service.js'
import type { TenantQueueStats } from '../services/tenant_queue_service.js'
import type { TenantPoolStat } from '../services/doctor/checks/connection_pool_check.js'
import type { IsthmusCountersSnapshot } from '../isthmus/audit.js'
import { ISTHMUS_REGISTRY } from '../isthmus/registry.js'
import { NO_SILENT_GUARD_ALLOWLIST } from '../isthmus/no_silent_guard_allowlist.js'
import { QUOTA_CEILING_GAUGE } from '../services/observability/names.js'

/**
 * Operator-global ceiling utilisation for one quota, derived at scrape from live
 * Redis. Labelled by `quota` only, never `tenant_id` (a cardinality bomb);
 * per-tenant budget detail lives in traces/logs, not the scrape.
 */
export interface QuotaCeilingStat {
  quota: string
  ceiling: number
  committed: number
  outstanding: number
  /** (committed + outstanding) / ceiling, in [0, 1+]; 0 when no finite ceiling. */
  utilization: number
}

export interface MetricsSnapshot {
  tenantsTotal: number
  tenantsByStatus: Record<string, number>
  circuits: Record<string, CircuitMetrics>
  queues: TenantQueueStats[]
  uptimeSeconds: number
  /** Per-connection tenant pool saturation. Optional so older snapshot literals stay valid. */
  poolSaturation?: TenantPoolStat[]
  /** Operator-global ceiling utilisation per quota. Optional for the same reason. */
  quotaCeilings?: QuotaCeilingStat[]
  /** Isthmus guard-trip counters (in-memory, per process). Optional for the same reason. */
  isthmus?: IsthmusCountersSnapshot
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

function metricLine(name: string, labels: Record<string, string | number>, value: number): string {
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

  lines.push(
    '# HELP multitenancy_circuit_state Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN).'
  )
  lines.push('# TYPE multitenancy_circuit_state gauge')
  lines.push('# HELP multitenancy_circuit_failures_total Failed calls observed by the circuit.')
  lines.push('# TYPE multitenancy_circuit_failures_total counter')
  lines.push(
    '# HELP multitenancy_circuit_successes_total Successful calls observed by the circuit.'
  )
  lines.push('# TYPE multitenancy_circuit_successes_total counter')
  for (const [tenantId, m] of Object.entries(snapshot.circuits)) {
    const labels = { tenant_id: tenantId }
    lines.push(metricLine('multitenancy_circuit_state', labels, CIRCUIT_STATE_VALUE[m.state] ?? 0))
    lines.push(metricLine('multitenancy_circuit_failures_total', labels, m.failures))
    lines.push(metricLine('multitenancy_circuit_successes_total', labels, m.successes))
  }

  lines.push(
    '# HELP multitenancy_queue_jobs Number of jobs in a tenant queue partitioned by state.'
  )
  lines.push('# TYPE multitenancy_queue_jobs gauge')
  for (const q of snapshot.queues) {
    const labels = { tenant_id: q.tenantId, queue: q.queueName }
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'waiting' }, q.waiting))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'active' }, q.active))
    lines.push(
      metricLine('multitenancy_queue_jobs', { ...labels, state: 'completed' }, q.completed)
    )
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'failed' }, q.failed))
    lines.push(metricLine('multitenancy_queue_jobs', { ...labels, state: 'delayed' }, q.delayed))
  }

  const pools = snapshot.poolSaturation ?? []
  if (pools.length > 0) {
    lines.push(
      '# HELP multitenancy_pool_saturation_ratio Tenant connection pool saturation (numUsed/max, 0..1).'
    )
    lines.push('# TYPE multitenancy_pool_saturation_ratio gauge')
    lines.push(
      '# HELP multitenancy_pool_pending_acquires Connections queued waiting for a pool slot.'
    )
    lines.push('# TYPE multitenancy_pool_pending_acquires gauge')
    for (const p of pools) {
      const labels = { connection: p.connection, tenant_id: p.tenantId ?? '' }
      lines.push(metricLine('multitenancy_pool_saturation_ratio', labels, p.ratio))
      lines.push(metricLine('multitenancy_pool_pending_acquires', labels, p.numPending))
    }
  }

  const ceilings = snapshot.quotaCeilings ?? []
  if (ceilings.length > 0) {
    lines.push(
      `# HELP ${QUOTA_CEILING_GAUGE.committed} Operator-global committed usage against a quota's ceiling.`
    )
    lines.push(`# TYPE ${QUOTA_CEILING_GAUGE.committed} gauge`)
    lines.push(
      `# HELP ${QUOTA_CEILING_GAUGE.outstanding} Operator-global reserved-but-unsettled amount held against a quota's ceiling.`
    )
    lines.push(`# TYPE ${QUOTA_CEILING_GAUGE.outstanding} gauge`)
    lines.push(
      `# HELP ${QUOTA_CEILING_GAUGE.utilization} Operator ceiling utilisation ((committed+outstanding)/ceiling).`
    )
    lines.push(`# TYPE ${QUOTA_CEILING_GAUGE.utilization} gauge`)
    for (const c of ceilings) {
      const labels = { quota: c.quota }
      lines.push(metricLine(QUOTA_CEILING_GAUGE.committed, labels, c.committed))
      lines.push(metricLine(QUOTA_CEILING_GAUGE.outstanding, labels, c.outstanding))
      lines.push(metricLine(QUOTA_CEILING_GAUGE.utilization, labels, c.utilization))
    }
  }

  const isthmus = snapshot.isthmus
  if (isthmus) {
    lines.push(
      '# HELP multitenancy_isthmus_guarded_total Isthmus guard trips by pillar and severity.'
    )
    lines.push('# TYPE multitenancy_isthmus_guarded_total counter')
    for (const g of isthmus.guarded) {
      lines.push(
        metricLine(
          'multitenancy_isthmus_guarded_total',
          { pillar: g.pillar, severity: g.severity },
          g.value
        )
      )
    }
    lines.push('# HELP multitenancy_isthmus_rejected_total Isthmus guard trips by guard id.')
    lines.push('# TYPE multitenancy_isthmus_rejected_total counter')
    for (const r of isthmus.rejected) {
      lines.push(
        metricLine(
          'multitenancy_isthmus_rejected_total',
          { pillar: r.pillar, severity: r.severity, id: r.id },
          r.value
        )
      )
    }
    lines.push(
      '# HELP multitenancy_isthmus_dropped_total Isthmus event dispatches suppressed (rate_limited) or failed (no_emitter). Counters above stay exact regardless.'
    )
    lines.push('# TYPE multitenancy_isthmus_dropped_total counter')
    for (const d of isthmus.dropped) {
      lines.push(
        metricLine(
          'multitenancy_isthmus_dropped_total',
          { severity: d.severity, reason: d.reason },
          d.value
        )
      )
    }
    // Entry-level coverage, derived from the two single-source modules. The CI
    // gate (scripts/check-isthmus.mjs) measures the finer throw-site index; this
    // gauge tracks the same variable a scrape can see: allowlist growth.
    lines.push(
      '# HELP multitenancy_isthmus_index Registered guard coverage: registered / (registered + allowlisted silent).'
    )
    lines.push('# TYPE multitenancy_isthmus_index gauge')
    const registered = ISTHMUS_REGISTRY.filter((e) => e.pillar !== 'audit').length
    lines.push(
      metricLine(
        'multitenancy_isthmus_index',
        {},
        registered / (registered + NO_SILENT_GUARD_ALLOWLIST.length)
      )
    )
  }

  lines.push('# HELP multitenancy_uptime_seconds Process uptime in seconds.')
  lines.push('# TYPE multitenancy_uptime_seconds gauge')
  lines.push(metricLine('multitenancy_uptime_seconds', {}, snapshot.uptimeSeconds))

  return lines.join('\n') + '\n'
}
