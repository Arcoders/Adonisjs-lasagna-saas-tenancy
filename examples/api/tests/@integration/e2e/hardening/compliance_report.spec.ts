import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { ComplianceReportService } from '@adonisjs-lasagna/saas-tenancy/services'
import { runAce } from '../_helpers.js'

/**
 * HARDENING — `tenant:compliance:report` introspects real posture.
 *
 * The report is a registry of controls (like tenant:doctor's checks). We assert
 * the machine-readable shape and real detection via the service (the demo has
 * the audit triggers, so audit-immutability is satisfied), the framework filter,
 * and the CLI's exit-code contract (--strict gates on action-needed; a control
 * that is satisfied stays exit 0 even under --strict).
 */
test.group('hardening — tenant:compliance:report', () => {
  test('the service report is machine-readable with a stable shape', async ({ assert }) => {
    const svc = await app.container.make(ComplianceReportService)
    const report = await svc.run({})

    assert.isArray(report.controls)
    assert.isAtLeast(report.controls.length, 1)
    for (const c of report.controls) {
      assert.properties(c, [
        'id',
        'title',
        'frameworks',
        'status',
        'evidence',
        'hostResponsibility',
      ])
      assert.oneOf(c.status, ['satisfied', 'action-needed', 'info'])
      assert.isArray(c.frameworks)
    }
    for (const k of ['satisfied', 'actionNeeded', 'info'] as const) {
      assert.isNumber(report.totals[k])
    }
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  })

  test('detects the installed immutability triggers as satisfied', async ({ assert }) => {
    const svc = await app.container.make(ComplianceReportService)
    const report = await svc.run({ controls: ['audit-immutability'] })
    assert.lengthOf(report.controls, 1)
    assert.equal(report.controls[0]!.status, 'satisfied')
  })

  test('--framework filters to controls mapping to that framework', async ({ assert }) => {
    const svc = await app.container.make(ComplianceReportService)
    const gdpr = await svc.run({ framework: 'gdpr' })
    assert.isAtLeast(gdpr.controls.length, 1)
    for (const c of gdpr.controls) {
      assert.isTrue(
        c.frameworks.some((f) => f.startsWith('gdpr')),
        `${c.id} should map to gdpr`
      )
    }
  })

  test('CLI: --json exits 0 without --strict; a satisfied control stays 0 under --strict', async ({
    assert,
  }) => {
    assert.oneOf(await runAce('tenant:compliance:report', ['--json']), [0])
    assert.oneOf(await runAce('tenant:compliance:report', ['--control=list']), [0])
    // audit-immutability is satisfied in the demo, so --strict must not trip it.
    assert.equal(
      await runAce('tenant:compliance:report', ['--control=audit-immutability', '--strict']),
      0
    )
  })
})
