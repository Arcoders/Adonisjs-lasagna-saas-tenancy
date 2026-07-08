import { test } from '@japa/runner'
import {
  TenantSchedulerService,
  type TenantSchedule,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { scheduleName } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

/**
 * SEAM-1 integration: `runTick` fans out over the REAL tenant repository, honoring
 * the status filter, against real Postgres — the part the unit test stubs. The
 * per-tenant queue is captured with a recording subclass (no Redis needed; the
 * BullMQ dispatch itself is covered by TenantQueueService's own specs). The
 * backoffice table is shared across the integration suite, so assertions are
 * SUBSET checks (my active tenants dispatched, my suspended one not), never an
 * exact-set match.
 */
interface DispatchCall {
  tenantId: string
  job: string
}

class RecordingScheduler extends TenantSchedulerService {
  readonly dispatches: DispatchCall[] = []
  protected async resolveQueue(): Promise<any> {
    return {
      dispatch: async (tenantId: string, job: string) => {
        this.dispatches.push({ tenantId, job })
      },
    }
  }
  protected jitterDelay(): number {
    return 0
  }
}

const intervalSchedule = (name: string, over: Partial<TenantSchedule> = {}): TenantSchedule => ({
  kind: 'schedule',
  name: scheduleName(name),
  job: 'app.NoopTenantJob',
  everyMs: 60_000,
  ...over,
})

test.group('scheduler runTick — fan-out over real active tenants', (group) => {
  const created: string[] = []

  group.teardown(async () => {
    for (const id of created) await destroyTestTenant(id).catch(() => {})
  })

  test('dispatches to ACTIVE tenants only (default filter)', async ({ assert }) => {
    const activeA = await createTestTenant({ status: 'active' })
    const activeB = await createTestTenant({ status: 'active' })
    const suspended = await createTestTenant({ status: 'suspended' })
    created.push(activeA.id, activeB.id, suspended.id)

    const svc = new RecordingScheduler()
    svc.register(intervalSchedule('sync'))
    const result = await svc.runTick('sync')

    assert.isTrue(result.found)
    const ids = svc.dispatches.map((d) => d.tenantId)
    assert.include(ids, activeA.id, 'active tenant A dispatched')
    assert.include(ids, activeB.id, 'active tenant B dispatched')
    assert.notInclude(ids, suspended.id, 'suspended tenant NOT dispatched')
    // every dispatch targets the schedule's job
    assert.isTrue(svc.dispatches.every((d) => d.job === 'app.NoopTenantJob'))
  })

  test('a widened status filter reaches suspended tenants too', async ({ assert }) => {
    const suspended = await createTestTenant({ status: 'suspended' })
    created.push(suspended.id)

    const svc = new RecordingScheduler()
    svc.register(intervalSchedule('wide', { statuses: ['active', 'suspended'] }))
    await svc.runTick('wide')

    assert.include(
      svc.dispatches.map((d) => d.tenantId),
      suspended.id,
      'suspended tenant reached when the schedule widens the status filter'
    )
  })
})
