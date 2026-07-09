import { test } from '@japa/runner'
import TenantSchedulerService, {
  type TenantSchedule,
  SCHEDULER_ACTIVE_STATUSES,
} from '../../../../src/services/tenant_scheduler_service.js'
import { scheduleName } from '../../../../src/sdk/brands.js'
import { schedulerJobId } from '../../../../src/sdk/plugin_keys.js'
import type { TenantStatus } from '../../../../src/types/contracts.js'

/**
 * The tenant scheduler (SEAM-1). Guarantees: registration fails closed on a
 * duplicate or an ambiguous cron/interval; `start()` arms one native schedule per
 * entry (or fails closed if it cannot); `runTick` fans out over ONLY the matching
 * tenant statuses, dispatches a deterministic best-effort `jobId` per tenant, and
 * is FAIL-OPEN per tenant — a single tenant's dispatch failure is caught inside
 * the `each` callback (a throw there would abort the whole cursor) so the fan-out
 * continues. A catastrophic enumeration failure surfaces as SchedulerTickException.
 *
 * Pure unit test: the PG/Redis-touching seams (`resolveRepo`, `resolveQueue`,
 * `armSchedule`) are overridden with in-memory doubles, so this runs with no
 * Ignitor, no live queue, and no database.
 */

interface FakeTenant {
  id: string
  status: TenantStatus
}

interface DispatchCall {
  tenantId: string
  job: string
  payload: Record<string, unknown>
  opts: { jobId?: string; delay?: number }
}

class TestScheduler extends TenantSchedulerService {
  armed: TenantSchedule[] = []
  armError: Error | null = null
  dispatches: DispatchCall[] = []
  tenants: FakeTenant[] = []
  failTenantIds = new Set<string>()
  enumerationError: Error | null = null
  nowValue = 1_700_000_000_000

  protected async armSchedule(schedule: TenantSchedule): Promise<void> {
    if (this.armError) throw this.armError
    this.armed.push(schedule)
  }

  protected async resolveRepo(): Promise<any> {
    const tenants = this.tenants
    const enumerationError = this.enumerationError
    return {
      each: async (
        cb: (t: FakeTenant) => Promise<void> | void,
        opts?: { statuses?: TenantStatus[] }
      ) => {
        if (enumerationError) throw enumerationError
        for (const t of tenants) {
          if (opts?.statuses && !opts.statuses.includes(t.status)) continue
          await cb(t)
        }
      },
    }
  }

  protected async resolveQueue(): Promise<any> {
    const dispatches = this.dispatches
    const failTenantIds = this.failTenantIds
    return {
      dispatch: async (
        tenantId: string,
        job: string,
        payload: Record<string, unknown>,
        opts: { jobId?: string; delay?: number }
      ) => {
        if (failTenantIds.has(tenantId)) throw new Error('dispatch boom')
        dispatches.push({ tenantId, job, payload, opts })
      },
    }
  }

  protected now(): number {
    return this.nowValue
  }

  protected jitterDelay(): number {
    return 0
  }
}

const intervalSchedule = (overrides: Partial<TenantSchedule> = {}): TenantSchedule => ({
  kind: 'schedule',
  name: scheduleName('sync'),
  job: 'app.SyncTenant',
  everyMs: 60_000,
  ...overrides,
})

test.group('TenantSchedulerService — registration', () => {
  test('registers a schedule and lists it', ({ assert }) => {
    const svc = new TestScheduler()
    svc.register(intervalSchedule())
    assert.deepEqual(svc.list(), ['sync'])
    assert.isTrue(svc.has(scheduleName('sync')))
    assert.equal(svc.get(scheduleName('sync'))?.job, 'app.SyncTenant')
  })

  test('a duplicate name fails closed (PluginBootException, phase=schedules)', ({ assert }) => {
    const svc = new TestScheduler()
    svc.register(intervalSchedule())
    try {
      svc.register(intervalSchedule())
      assert.fail('expected a duplicate registration to throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.phase, 'schedules')
    }
  })

  test('must set EXACTLY one of cron / everyMs', ({ assert }) => {
    const svc = new TestScheduler()
    // neither
    assert.throws(
      () => svc.register({ kind: 'schedule', name: scheduleName('a'), job: 'j' }),
      /exactly one of "cron" or "everyMs"/
    )
    // both
    assert.throws(
      () =>
        svc.register({
          kind: 'schedule',
          name: scheduleName('b'),
          job: 'j',
          cron: '* * * * *',
          everyMs: 1000,
        }),
      /exactly one of "cron" or "everyMs"/
    )
    // cron only — ok
    assert.doesNotThrow(() =>
      svc.register({ kind: 'schedule', name: scheduleName('c'), job: 'j', cron: '0 2 * * *' })
    )
    // everyMs only — ok
    assert.doesNotThrow(() =>
      svc.register({ kind: 'schedule', name: scheduleName('d'), job: 'j', everyMs: 5000 })
    )
  })

  test('everyMs must be a finite integer >= 1', ({ assert }) => {
    const svc = new TestScheduler()
    assert.throws(
      () => svc.register({ kind: 'schedule', name: scheduleName('z'), job: 'j', everyMs: 0 }),
      /everyMs must be a finite integer >= 1/
    )
  })

  test('unregister removes it', ({ assert }) => {
    const svc = new TestScheduler()
    svc.register(intervalSchedule())
    assert.isTrue(svc.unregister(scheduleName('sync')))
    assert.deepEqual(svc.list(), [])
  })
})

test.group('TenantSchedulerService — start (arming)', () => {
  test('arms one native schedule per registered entry', async ({ assert }) => {
    const svc = new TestScheduler()
    svc.register(intervalSchedule({ name: scheduleName('a') }))
    // A cron schedule carries no interval: omit everyMs entirely (runtime-equivalent
    // to setting it undefined) so exactly one of cron/everyMs is present.
    const cronB: TenantSchedule = {
      kind: 'schedule',
      name: scheduleName('b'),
      job: 'app.SyncTenant',
      cron: '0 * * * *',
    }
    svc.register(cronB)
    await svc.start()
    assert.deepEqual(
      svc.armed.map((s) => String(s.name)),
      ['a', 'b']
    )
  })

  test('no-op when nothing is registered', async ({ assert }) => {
    const svc = new TestScheduler()
    await svc.start()
    assert.deepEqual(svc.armed, [])
  })

  test('fails closed when a schedule cannot be armed (worker/console default)', async ({
    assert,
  }) => {
    const svc = new TestScheduler()
    svc.armError = new Error('queue down')
    svc.register(intervalSchedule())
    try {
      await svc.start() // failClosed defaults to true
      assert.fail('expected start() to throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.phase, 'schedules')
      assert.match(String(err.cause?.message), /queue down/)
    }
  })

  test('fail-open (web) swallows an arm failure instead of aborting boot', async ({ assert }) => {
    const svc = new TestScheduler()
    svc.armError = new Error('queue blip')
    svc.register(intervalSchedule())
    // The web process must NOT fail readiness on a queue-backend blip — the worker
    // arms the shared schedule. So failClosed:false logs and returns, never throws.
    await assert.doesNotReject(() => svc.start({ failClosed: false }))
  })
})

test.group('TenantSchedulerService — runTick fan-out', () => {
  test('dispatches to ACTIVE tenants only by default', async ({ assert }) => {
    const svc = new TestScheduler()
    svc.tenants = [
      { id: 't1', status: 'active' },
      { id: 't2', status: 'suspended' },
      { id: 't3', status: 'active' },
      { id: 't4', status: 'provisioning' },
    ]
    svc.register(intervalSchedule())
    const result = await svc.runTick('sync')
    assert.equal(result.found, true)
    assert.equal(result.dispatched, 2)
    assert.equal(result.failed, 0)
    assert.deepEqual(
      svc.dispatches.map((d) => d.tenantId),
      ['t1', 't3']
    )
    // default status filter is exactly the ACTIVE set
    assert.deepEqual([...SCHEDULER_ACTIVE_STATUSES], ['active'])
  })

  test('a schedule can widen the status filter', async ({ assert }) => {
    const svc = new TestScheduler()
    svc.tenants = [
      { id: 't1', status: 'active' },
      { id: 't2', status: 'suspended' },
    ]
    svc.register(intervalSchedule({ statuses: ['active', 'suspended'] }))
    const result = await svc.runTick('sync')
    assert.equal(result.dispatched, 2)
  })

  test('per-tenant jobId is deterministic (schedule:tenant:period) and payload flows', async ({
    assert,
  }) => {
    const svc = new TestScheduler()
    svc.tenants = [{ id: 't1', status: 'active' }]
    svc.register(intervalSchedule({ payload: { kind: 'nightly' } }))
    await svc.runTick('sync')
    const call = svc.dispatches[0]!
    const period = Math.floor(svc.nowValue / 60_000)
    assert.equal(call.opts.jobId, schedulerJobId(scheduleName('sync'), 't1', period))
    assert.deepEqual(call.payload, { kind: 'nightly' })
    assert.equal(call.job, 'app.SyncTenant')
  })

  test('FAIL-OPEN: one tenant dispatch failure does not abort the fan-out', async ({ assert }) => {
    const svc = new TestScheduler()
    svc.tenants = [
      { id: 't1', status: 'active' },
      { id: 't2', status: 'active' },
      { id: 't3', status: 'active' },
    ]
    svc.failTenantIds.add('t2')
    svc.register(intervalSchedule())
    const result = await svc.runTick('sync')
    assert.equal(result.dispatched, 2)
    assert.equal(result.failed, 1)
    // t1 AND t3 still dispatched — t2's failure did not starve the later tenants
    assert.deepEqual(
      svc.dispatches.map((d) => d.tenantId),
      ['t1', 't3']
    )
  })

  test('an unregistered schedule is a no-op (found=false, nothing dispatched)', async ({
    assert,
  }) => {
    const svc = new TestScheduler()
    svc.tenants = [{ id: 't1', status: 'active' }]
    const result = await svc.runTick('ghost')
    assert.equal(result.found, false)
    assert.equal(result.dispatched, 0)
    assert.deepEqual(svc.dispatches, [])
  })

  test('a catastrophic enumeration failure surfaces as SchedulerTickException', async ({
    assert,
  }) => {
    const svc = new TestScheduler()
    svc.enumerationError = new Error('db exploded')
    svc.register(intervalSchedule())
    try {
      await svc.runTick('sync')
      assert.fail('expected runTick to throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_SCHEDULER_TICK')
      assert.equal(err.status, 500)
      assert.equal(err.schedule, 'sync')
      assert.match(String(err.cause?.message), /db exploded/)
    }
  })
})
