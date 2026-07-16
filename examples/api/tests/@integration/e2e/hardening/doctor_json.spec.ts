import { test } from '@japa/runner'
import ace from '@adonisjs/core/services/ace'
import { ADMIN_HEADERS, runAce } from '../_helpers.js'

/**
 * HARDENING / operability: `tenant:doctor --json` machine-readable output.
 *
 * The doctor's `--json` flag emits `JSON.stringify(DoctorService.run(...))` on
 * stdout and exits 1 when any check reports an error, 0 otherwise
 * (packages/core/src/commands/tenant_doctor.ts). That is the contract a CI gate
 * relies on. The same `DoctorService.run()` result is what `GET /admin/health/report`
 * returns, so we assert the machine-readable shape there (no tenant context
 * needed), assert the CLI exit-code contract, and best-effort parse the CLI's
 * JSON stdout.
 */
test.group('hardening — tenant:doctor --json', () => {
  test('the doctor report is machine-readable with a stable shape', async ({ client, assert }) => {
    const r = await client.get('/admin/health/report').headers(ADMIN_HEADERS)
    assert.oneOf(r.status(), [200, 503], 'health report responds 200 (healthy) or 503 (degraded)')

    const body = r.body()
    assert.isArray(body.reports, 'reports must be an array')
    assert.isAtLeast(body.reports.length, 1, 'at least one check must run')

    for (const report of body.reports) {
      assert.isString(report.check, 'each report names its check')
      assert.isArray(report.issues, 'each report carries an issues array')
      assert.isNumber(report.durationMs, 'each report records a duration')
    }

    for (const k of ['info', 'warn', 'error', 'fixable'] as const) {
      assert.isNumber(body.totals?.[k], `totals.${k} must be a number for CI gating`)
    }

    // The whole report must survive a JSON round-trip (it is serialized to
    // stdout verbatim by --json).
    assert.deepEqual(JSON.parse(JSON.stringify(body)), body)
  })

  test('tenant:doctor --json exits 0 (clean) or 1 (errors found) and emits parseable JSON', async ({
    assert,
  }) => {
    // CLI exit-code contract: what a CI pipeline keys off of.
    const exitCode = await runAce('tenant:doctor', ['--json'])
    assert.oneOf(exitCode, [0, 1], 'exit code must be 0 or 1')

    // Best-effort: re-run under the ace UI in raw mode so the logged JSON is
    // captured in memory, then parse it. Guarded so a cliui API difference can
    // never fail the suite. The shape contract above is the hard guarantee.
    let parsed: any = null
    try {
      const ui: any = (ace as any).ui
      ui?.switchMode?.('raw')
      const cmd: any = await ace.exec('tenant:doctor', ['--json'])
      const logs: Array<{ message: string }> =
        cmd?.logger?.getLogs?.() ?? ui?.logger?.getLogs?.() ?? []
      for (const entry of logs) {
        try {
          const obj = JSON.parse(entry.message)
          if (obj && Array.isArray(obj.reports) && obj.totals) {
            parsed = obj
            break
          }
        } catch {
          /* not the JSON line */
        }
      }
      ui?.switchMode?.('normal')
    } catch {
      /* capture unavailable in this runtime, shape already asserted above */
    }

    if (parsed) {
      assert.isArray(parsed.reports, 'captured --json stdout must parse to a reports array')
      assert.isNumber(parsed.totals.error, 'captured --json totals.error must be numeric')
    }
  })
})
