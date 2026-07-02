import { test } from '@japa/runner'
import { renderPrometheus, type MetricsSnapshot } from '../../../../src/health/metrics_exporter.js'

function emptySnapshot(): MetricsSnapshot {
  return {
    tenantsTotal: 0,
    tenantsByStatus: {},
    circuits: {},
    queues: [],
    uptimeSeconds: 0,
  }
}

test.group('renderPrometheus — format', () => {
  test('emits HELP and TYPE comments for each family', ({ assert }) => {
    const out = renderPrometheus(emptySnapshot())
    assert.include(out, '# HELP multitenancy_tenants_total')
    assert.include(out, '# TYPE multitenancy_tenants_total gauge')
    assert.include(out, '# HELP multitenancy_circuit_state')
    assert.include(out, '# TYPE multitenancy_uptime_seconds gauge')
  })

  test('ends with a newline', ({ assert }) => {
    const out = renderPrometheus(emptySnapshot())
    assert.equal(out.charAt(out.length - 1), '\n')
  })

  test('renders tenants_total without labels', ({ assert }) => {
    const out = renderPrometheus({ ...emptySnapshot(), tenantsTotal: 7 })
    assert.match(out, /^multitenancy_tenants_total 7$/m)
  })

  test('renders tenants_by_status with status label', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      tenantsByStatus: { active: 5, suspended: 1 },
    })
    assert.match(out, /multitenancy_tenants_by_status\{status="active"\} 5/)
    assert.match(out, /multitenancy_tenants_by_status\{status="suspended"\} 1/)
  })

  test('renders circuit_state with numeric encoding', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      circuits: {
        t1: { tenantId: 't1', state: 'CLOSED', failures: 0, successes: 10, fallbackCalls: 0 },
        t2: { tenantId: 't2', state: 'HALF_OPEN', failures: 2, successes: 0, fallbackCalls: 0 },
        t3: { tenantId: 't3', state: 'OPEN', failures: 5, successes: 0, fallbackCalls: 0 },
      },
    })
    assert.match(out, /multitenancy_circuit_state\{tenant_id="t1"\} 0/)
    assert.match(out, /multitenancy_circuit_state\{tenant_id="t2"\} 1/)
    assert.match(out, /multitenancy_circuit_state\{tenant_id="t3"\} 2/)
    assert.match(out, /multitenancy_circuit_failures_total\{tenant_id="t3"\} 5/)
    assert.match(out, /multitenancy_circuit_successes_total\{tenant_id="t1"\} 10/)
  })

  test('renders queue_jobs partitioned by state', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      queues: [
        {
          tenantId: 'tA',
          queueName: 'tenant_queue_tA',
          waiting: 3,
          active: 1,
          completed: 100,
          failed: 2,
          delayed: 0,
        },
      ],
    })
    assert.match(
      out,
      /multitenancy_queue_jobs\{tenant_id="tA",queue="tenant_queue_tA",state="waiting"\} 3/
    )
    assert.match(
      out,
      /multitenancy_queue_jobs\{tenant_id="tA",queue="tenant_queue_tA",state="active"\} 1/
    )
    assert.match(
      out,
      /multitenancy_queue_jobs\{tenant_id="tA",queue="tenant_queue_tA",state="completed"\} 100/
    )
    assert.match(
      out,
      /multitenancy_queue_jobs\{tenant_id="tA",queue="tenant_queue_tA",state="failed"\} 2/
    )
    assert.match(
      out,
      /multitenancy_queue_jobs\{tenant_id="tA",queue="tenant_queue_tA",state="delayed"\} 0/
    )
  })

  test('renders uptime', ({ assert }) => {
    const out = renderPrometheus({ ...emptySnapshot(), uptimeSeconds: 42 })
    assert.match(out, /multitenancy_uptime_seconds 42/)
  })

  test('renders tenant pool saturation as a gauge with connection + tenant labels', ({
    assert,
  }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      poolSaturation: [
        {
          connection: 'tenant_abc',
          tenantId: 'abc',
          numUsed: 9,
          numFree: 1,
          numPending: 3,
          max: 10,
          ratio: 0.9,
        },
      ],
    })
    assert.include(out, '# TYPE multitenancy_pool_saturation_ratio gauge')
    assert.match(
      out,
      /multitenancy_pool_saturation_ratio\{connection="tenant_abc",tenant_id="abc"\} 0\.9/
    )
    assert.match(
      out,
      /multitenancy_pool_pending_acquires\{connection="tenant_abc",tenant_id="abc"\} 3/
    )
  })

  test('omits the pool family entirely when there is no saturation data', ({ assert }) => {
    const out = renderPrometheus(emptySnapshot())
    assert.notInclude(out, 'multitenancy_pool_saturation_ratio')
  })

  test('renders the four Isthmus families from the counters snapshot', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      isthmus: {
        guarded: [{ pillar: 'seal', severity: 'critical', value: 2 }],
        rejected: [{ id: 'seal.tenant_context', pillar: 'seal', severity: 'critical', value: 2 }],
        dropped: [{ severity: 'critical', reason: 'rate_limited', value: 1 }],
      },
    })
    assert.include(out, '# TYPE multitenancy_isthmus_guarded_total counter')
    assert.match(out, /multitenancy_isthmus_guarded_total\{pillar="seal",severity="critical"\} 2/)
    assert.match(
      out,
      /multitenancy_isthmus_rejected_total\{pillar="seal",severity="critical",id="seal\.tenant_context"\} 2/
    )
    assert.match(
      out,
      /multitenancy_isthmus_dropped_total\{severity="critical",reason="rate_limited"\} 1/
    )
    // The gauge is derived from the registry + allowlist sizes and always in (0, 1].
    const index = out.match(/^multitenancy_isthmus_index (.+)$/m)
    assert.isNotNull(index, 'the index gauge must render')
    const value = Number(index![1])
    assert.isTrue(value > 0 && value <= 1, `index gauge out of range: ${value}`)
  })

  test('omits the Isthmus families when the snapshot carries no counters', ({ assert }) => {
    const out = renderPrometheus(emptySnapshot())
    assert.notInclude(out, 'multitenancy_isthmus_')
  })
})

test.group('renderPrometheus — escaping', () => {
  test('escapes label values with double quotes and backslashes', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      tenantsByStatus: { 'a"b\\c': 1 } as any,
    })
    assert.include(out, 'status="a\\"b\\\\c"')
  })

  test('handles non-finite numeric values as 0', ({ assert }) => {
    const out = renderPrometheus({
      ...emptySnapshot(),
      tenantsTotal: Number.NaN as any,
    })
    assert.match(out, /^multitenancy_tenants_total 0$/m)
  })
})
