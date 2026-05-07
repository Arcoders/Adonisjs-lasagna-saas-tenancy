import { test } from '@japa/runner'
import DoctorService from '../../../../src/services/doctor/doctor_service.js'
import type { DoctorCheck } from '../../../../src/services/doctor/types.js'
import { mockTenantRepository } from '../../../../src/testing/mock_repository.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig } from '../../../helpers/config.js'

function passing(name: string): DoctorCheck {
  return {
    name,
    description: `passing ${name}`,
    run: () => [],
  }
}

function failing(name: string, code: string): DoctorCheck {
  return {
    name,
    description: `failing ${name}`,
    run: () => [
      {
        code,
        severity: 'error' as const,
        message: `${code} fired`,
        fixable: false,
      },
    ],
  }
}

test.group('DoctorService — registry', (group) => {
  group.each.setup(() => setupTestConfig())

  test('register/unregister/has/list reflect the current state', ({ assert }) => {
    const svc = new DoctorService()
    assert.lengthOf(svc.list(), 0)

    svc.register(passing('a'))
    svc.register(passing('b'))
    assert.lengthOf(svc.list(), 2)
    assert.isTrue(svc.has('a'))
    assert.isTrue(svc.has('b'))

    svc.unregister('a')
    assert.isFalse(svc.has('a'))
    assert.lengthOf(svc.list(), 1)
  })

  test('register overwrites a check with the same name', ({ assert }) => {
    const svc = new DoctorService()
    svc.register(passing('x'))
    svc.register(failing('x', 'fail_x'))
    assert.lengthOf(svc.list(), 1)
  })
})

test.group('DoctorService — run() orchestration', (group) => {
  group.each.setup(() => setupTestConfig())

  test('runs every registered check by default', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(passing('a'))
    svc.register(passing('b'))
    const result = await svc.run({}, mockTenantRepository())
    assert.deepEqual(
      result.reports.map((r) => r.check),
      ['a', 'b']
    )
  })

  test('filters by --check names', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register(passing('a'))
    svc.register(passing('b'))
    svc.register(passing('c'))
    const result = await svc.run({ checks: ['a', 'c'] }, mockTenantRepository())
    assert.deepEqual(
      result.reports.map((r) => r.check).sort(),
      ['a', 'c']
    )
  })

  test('filters tenants by --tenant', async ({ assert }) => {
    const repo = mockTenantRepository()
    const t1 = buildTestTenant()
    const t2 = buildTestTenant()
    repo.add(t1).add(t2)

    let observedIds: string[] = []
    const svc = new DoctorService()
    svc.register({
      name: 'spy',
      description: 'spy',
      run: (ctx) => {
        observedIds = ctx.tenants.map((t) => t.id)
        return []
      },
    })

    await svc.run({ tenants: [t2.id] }, repo)
    assert.deepEqual(observedIds, [t2.id])
  })

  test('aggregates totals across reports', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register({
      name: 'mix',
      description: '',
      run: () => [
        { code: 'i', severity: 'info', message: 'i' },
        { code: 'w', severity: 'warn', message: 'w', fixable: true },
        { code: 'e', severity: 'error', message: 'e', fixable: true },
      ],
    })
    const r = await svc.run({}, mockTenantRepository())
    assert.equal(r.totals.info, 1)
    assert.equal(r.totals.warn, 1)
    assert.equal(r.totals.error, 1)
    assert.equal(r.totals.fixable, 2)
  })

  test('a throwing check does not abort the run; error is recorded', async ({ assert }) => {
    const svc = new DoctorService()
    svc.register({
      name: 'kaboom',
      description: '',
      run: () => {
        throw new Error('oops')
      },
    })
    svc.register(passing('after'))
    const r = await svc.run({}, mockTenantRepository())
    assert.equal(r.reports[0].check, 'kaboom')
    assert.match(r.reports[0].error ?? '', /oops/)
    assert.lengthOf(r.reports[0].issues, 0)
    assert.equal(r.reports[1].check, 'after')
  })

  test('passes attemptFix flag to ctx', async ({ assert }) => {
    const svc = new DoctorService()
    let observed = false
    svc.register({
      name: 'flag',
      description: '',
      run: (ctx) => {
        observed = ctx.attemptFix
        return []
      },
    })
    await svc.run({ fix: true }, mockTenantRepository())
    assert.isTrue(observed)
  })
})
