import { test } from '@japa/runner'
import DoctorService from '../../../../src/services/doctor/doctor_service.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'
import type { TenantRepositoryContract } from '../../../../src/types/contracts.js'

/**
 * DoctorService and metrics loaded all tenants at once.
 *
 * DoctorService.run loaded every tenant with one unbounded `repo.all()` on each
 * run, an O(n-tenants) full-table load that spikes memory at scale. The fix
 * cursor-iterates via `repo.each()` (keyset pagination). This uses a recording
 * repo whose `each()` does NOT delegate to `all()`, so it can prove which path
 * the service actually takes.
 *
 * Before the fix, `all` is called once and `each` zero times.
 */
function recordingRepo(tenants: ReturnType<typeof buildTestTenant>[]) {
  const calls = { all: 0, each: 0 }
  const repo = {
    all: async () => {
      calls.all++
      return tenants
    },
    each: async (cb: (t: any) => unknown) => {
      calls.each++
      for (const t of tenants) await cb(t)
    },
  } as unknown as TenantRepositoryContract
  return { repo, calls }
}

test.group('DoctorService — bounded tenant iteration', (group) => {
  group.each.setup(() => setupTestConfig())

  test('iterates tenants via each(), never via an unbounded all()', async ({ assert }) => {
    const { repo, calls } = recordingRepo([buildTestTenant(), buildTestTenant()])
    let seen = 0
    const svc = new DoctorService()
    svc.register({
      name: 'spy',
      description: '',
      run: (ctx) => {
        seen = ctx.tenants.length
        return []
      },
    })

    await svc.run({}, repo)

    assert.equal(calls.each, 1, 'must cursor-iterate via each()')
    assert.equal(calls.all, 0, 'must NOT load every tenant in one query')
    assert.equal(seen, 2, 'checks still receive the full tenant list')
  })

  test('--tenant filter is applied during iteration', async ({ assert }) => {
    const t1 = buildTestTenant()
    const t2 = buildTestTenant()
    const { repo } = recordingRepo([t1, t2])
    let observed: string[] = []
    const svc = new DoctorService()
    svc.register({
      name: 'spy',
      description: '',
      run: (ctx) => {
        observed = ctx.tenants.map((t) => t.id)
        return []
      },
    })

    await svc.run({ tenants: [t2.id] }, repo)
    assert.deepEqual(observed, [t2.id])
  })
})
