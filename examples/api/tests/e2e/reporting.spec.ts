import { test } from '@japa/runner'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createInstalledTenant, dropAllTenants, runAce, ADMIN_HEADERS } from './_helpers.js'

/**
 * E2E coverage of the reporting satellite end to end: the TrackMetricsMiddleware
 * counts a tenant request, a custom metric is emitted, `tenant:metrics:flush`
 * writes both to the backoffice schema, and the admin dashboard reads them back.
 * Also exercises the report-extension endpoint and the CLI's --format/--extension.
 *
 * This is where the middleware + commands actually execute (per CLAUDE.md, CLI /
 * middleware execution coverage lives in e2e, not the metadata-only command specs).
 */
test.group('e2e — reporting: metrics pipeline + dashboard + extensions', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('request + custom metric round-trip the dashboard after flush', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    // A tenant-scoped request — TrackMetricsMiddleware (bypassInTestEnv: false)
    // records it against the tenant.
    const note = await client.get('/demo/notes').header('x-tenant-id', id)
    note.assertStatus(200)

    // Emit a host-defined custom metric the same request would.
    await new MetricsService().emitMetric(id, 'notes_created', 1)

    // Flush Redis counters → backoffice (both built-in and custom).
    assert.equal(await runAce('tenant:metrics:flush'), 0)

    // The admin dashboard reads them back.
    const dash = await client.get('/admin/reporting/dashboard').headers(ADMIN_HEADERS)
    dash.assertStatus(200)
    const data = dash.body().data
    const totalRequests = data.aggregate.reduce((acc: number, r: any) => acc + r.totalRequests, 0)
    assert.isAtLeast(totalRequests, 1, 'the tenant request was counted and flushed')
    const custom = (data.customMetrics as Array<{ name: string; total: number }>).find(
      (m) => m.name === 'notes_created'
    )
    assert.exists(custom, 'custom metric appears in the dashboard')
    assert.isAtLeast(custom!.total, 1)
  })

  test('dashboard is fail-closed without admin auth', async ({ client, assert }) => {
    const res = await client.get('/admin/reporting/dashboard')
    assert.notEqual(res.status(), 200)
  })

  test('the report-extension endpoint runs a registered extension', async ({ client }) => {
    const res = await client
      .get('/admin/reporting/reports/extension/demo_summary')
      .headers(ADMIN_HEADERS)
    res.assertStatus(200)
    res.assertBodyContains({ data: { ok: true } })
  })

  test('an unknown extension is a 404', async ({ client }) => {
    const res = await client
      .get('/admin/reporting/reports/extension/does_not_exist')
      .headers(ADMIN_HEADERS)
    res.assertStatus(404)
  })

  test('the CLI generates a report in json and runs an extension', async ({ assert }) => {
    assert.equal(await runAce('tenant:report:generate', ['--format=json']), 0)
    assert.equal(await runAce('tenant:report:generate', ['--extension=demo_summary']), 0)
  })

  test('openapi.json is served under admin auth', async ({ client, assert }) => {
    const res = await client.get('/admin/reporting/openapi.json').headers(ADMIN_HEADERS)
    res.assertStatus(200)
    assert.equal(res.body().openapi, '3.1.0')
    assert.exists(res.body().paths['/admin/reporting/dashboard'])
  })
})
