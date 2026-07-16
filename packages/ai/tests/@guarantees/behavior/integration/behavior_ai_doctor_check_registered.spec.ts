import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { DoctorService } from '@adonisjs-lasagna/saas-tenancy/services'
import AiProvider from '../../../../providers/ai_provider.js'

/**
 * Integration: `AiProvider.boot()` registers the `ai_membership_gate` check
 * into the REAL DoctorService, so `tenant:doctor --check=ai_membership_gate`
 * runs it. The kit fixture declares no `config.ai`, so the healthy (no-issue)
 * posture is what the run must report.
 */
test.group('ai doctor check registration (integration)', () => {
  test('boot registers ai_membership_gate and a filtered doctor run executes it', async ({
    assert,
  }) => {
    const provider = new AiProvider(app)
    provider.register()
    await provider.boot()

    const doctor = await app.container.make(DoctorService)
    const result = await doctor.run({ checks: ['ai_membership_gate'], tenants: [] })

    const report = result.reports.find((r) => r.check === 'ai_membership_gate')
    assert.isDefined(report, 'the check must be registered and runnable')
    assert.isUndefined(report!.error)
    assert.deepEqual(report!.issues, [], 'no config.ai means a healthy posture')
  })

  test('boot registers ai_budget and a filtered doctor run executes it', async ({ assert }) => {
    const provider = new AiProvider(app)
    provider.register()
    await provider.boot()

    const doctor = await app.container.make(DoctorService)
    const result = await doctor.run({ checks: ['ai_budget'], tenants: [] })

    const report = result.reports.find((r) => r.check === 'ai_budget')
    assert.isDefined(report, 'the budget check must be registered and runnable')
    assert.isUndefined(report!.error)
    assert.deepEqual(report!.issues, [], 'no config.ai means nothing to meter, a healthy posture')
  })

  test('boot registers ai_tools and a filtered doctor run executes it', async ({ assert }) => {
    const provider = new AiProvider(app)
    provider.register()
    await provider.boot()

    const doctor = await app.container.make(DoctorService)
    const result = await doctor.run({ checks: ['ai_tools'], tenants: [] })

    const report = result.reports.find((r) => r.check === 'ai_tools')
    assert.isDefined(report, 'the tools check must be registered and runnable')
    assert.isUndefined(report!.error)
    assert.deepEqual(report!.issues, [], 'no config.ai means no tools offered, a healthy posture')
  })
})
