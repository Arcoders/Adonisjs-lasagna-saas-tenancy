import { test } from '@japa/runner'
import TenantJob, { type TenantJobPayload } from '../../../../src/jobs/tenant_job.js'
import BootstrapperRegistry from '../../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import { tenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

const fakeTenant = (id: string) => ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

const fakeContext = (jobId = 'job-1') =>
  ({
    jobId,
    name: 'TestTenantJob',
    attempt: 1,
    queue: 'default',
    priority: 5,
    acquiredAt: new Date(0),
    stalledCount: 0,
  }) as any

interface SpyPayload extends TenantJobPayload {
  marker?: string
}

/**
 * Subclass that records the tenant id observed *inside* perform(), and resolves
 * the tenant through an in-memory map instead of the container (the
 * `resolveTenant` seam) so no booted app is needed.
 */
class SpyTenantJob extends TenantJob<SpyPayload> {
  observedTenantId: string | undefined = 'UNSET'
  resolvedFor: string[] = []

  protected async resolveTenant(tenantId: string): Promise<TenantModelContract> {
    this.resolvedFor.push(tenantId)
    if (tenantId === 'missing') throw new Error('tenant not found')
    return fakeTenant(tenantId)
  }

  protected async perform(): Promise<void> {
    // Read through an await to also prove AsyncLocalStorage continuity.
    await Promise.resolve()
    this.observedTenantId = tenancy.currentId()
  }
}

function makeJob(payload: SpyPayload): SpyTenantJob {
  const job = new SpyTenantJob()
  job.$hydrate(payload, fakeContext())
  return job
}

test.group('TenantJob', (group) => {
  group.each.setup(() => {
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
  })
  group.each.teardown(() => __configureTenancyForTests({}))

  test('runs perform() inside a tenancy.run() scope for the payload tenant', async ({ assert }) => {
    const job = makeJob({ tenantId: 'abc' })
    await job.execute()

    assert.deepEqual(job.resolvedFor, ['abc'])
    assert.equal(job.observedTenantId, 'abc', 'tenancy.currentId() resolves inside perform()')
    assert.isUndefined(tenancy.currentId(), 'scope is torn down after execute() returns')
  })

  test('a global job (no tenantId) runs perform() with NO tenant scope', async ({ assert }) => {
    const job = makeJob({ marker: 'global' })
    await job.execute()

    assert.lengthOf(job.resolvedFor, 0, 'never resolves a tenant for a global job')
    assert.isUndefined(job.observedTenantId, 'perform() runs outside any tenant scope')
  })

  test('propagates a resolution failure (so BullMQ retries)', async ({ assert }) => {
    const job = makeJob({ tenantId: 'missing' })
    await assert.rejects(() => job.execute(), /tenant not found/)
  })

  test('parallel jobs for different tenants do not leak context into each other', async ({
    assert,
  }) => {
    const seen: Record<string, string | undefined> = {}

    class RecordingJob extends SpyTenantJob {
      protected async perform(): Promise<void> {
        // Yield so the two jobs interleave; each must still observe its own id.
        await new Promise((r) => setTimeout(r, 5))
        seen[this.payload.tenantId!] = tenancy.currentId()
      }
    }

    const a = new RecordingJob()
    a.$hydrate({ tenantId: 'alpha' }, fakeContext('a'))
    const b = new RecordingJob()
    b.$hydrate({ tenantId: 'beta' }, fakeContext('b'))

    await Promise.all([a.execute(), b.execute()])

    assert.equal(seen.alpha, 'alpha')
    assert.equal(seen.beta, 'beta')
  })
})
