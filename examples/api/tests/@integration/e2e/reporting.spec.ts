import { test } from '@japa/runner'
import emitter from '@adonisjs/core/services/emitter'
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import { MetricsFlushed } from '@adonisjs-lasagna/saas-tenancy/events'
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

    // A tenant-scoped request. TrackMetricsMiddleware (bypassInTestEnv: false)
    // records it against the tenant.
    const note = await client.get('/demo/notes').header('x-tenant-id', id)
    note.assertStatus(200)

    // Emit a host-defined custom metric the same request would.
    await new MetricsService().emitMetric(id, 'notes_created', 1)

    // Flush Redis counters into the backoffice (both built-in and custom).
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

  test('the slow_tenants fan-out extension runs (bounded mapTenants)', async ({
    client,
    assert,
  }) => {
    const res = await client
      .get('/admin/reporting/reports/extension/slow_tenants')
      .headers(ADMIN_HEADERS)
    res.assertStatus(200)
    const data = res.body().data
    assert.property(data, 'scanned')
    assert.equal(data.failed, 0)
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

  test('the dashboard payload carries dataAsOf', async ({ client, assert }) => {
    const res = await client.get('/admin/reporting/dashboard').headers(ADMIN_HEADERS)
    res.assertStatus(200)
    assert.property(res.body().data, 'dataAsOf')
  })

  test('tenant:metrics:flush dispatches MetricsFlushed once', async ({ assert }) => {
    let fired = 0
    const handler = () => {
      fired += 1
    }
    emitter.on(MetricsFlushed, handler)
    try {
      assert.equal(await runAce('tenant:metrics:flush'), 0)
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      emitter.off(MetricsFlushed, handler)
    }
    assert.equal(fired, 1)
  })

  test('a flush invalidates the cached dashboard (cache.invalidateOnFlush)', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    // Populate the (60s TTL) cache.
    const first = await client.get('/admin/reporting/dashboard').headers(ADMIN_HEADERS)
    first.assertStatus(200)
    const beforeTotal = first
      .body()
      .data.aggregate.reduce((a: number, r: any) => a + r.totalRequests, 0)

    // Generate a new tracked request and flush it to the backoffice.
    await client.get('/demo/notes').header('x-tenant-id', id)
    assert.equal(await runAce('tenant:metrics:flush'), 0)
    // The MetricsFlushed listener clears the cache asynchronously (the emitter
    // doesn't await listeners), so let it settle before reading.
    await new Promise((r) => setTimeout(r, 200))

    // Within the TTL: a fresh value here proves the cache was cleared on flush.
    const second = await client.get('/admin/reporting/dashboard').headers(ADMIN_HEADERS)
    const afterTotal = second
      .body()
      .data.aggregate.reduce((a: number, r: any) => a + r.totalRequests, 0)
    assert.isAbove(afterTotal, beforeTotal)
  })

  test('a throwing MetricsFlushed listener does not fail the flush command', async ({ assert }) => {
    const handler = () => {
      throw new Error('listener blew up')
    }
    emitter.on(MetricsFlushed, handler)
    try {
      assert.equal(await runAce('tenant:metrics:flush'), 0) // best-effort dispatch
    } finally {
      emitter.off(MetricsFlushed, handler)
    }
  })

  test('tenant:metrics:rollup runs green (monthly rollup path)', async ({ assert }) => {
    assert.equal(await runAce('tenant:metrics:rollup'), 0)
  })
})
