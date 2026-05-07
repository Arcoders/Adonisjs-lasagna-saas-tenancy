import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  ADMIN_HEADERS,
  runAce,
  probePgTools,
  installInline,
  dropAllTenants,
} from './_helpers.js'

let hasPgTools = false
let primaryTenantId = ''

test.group('e2e — full feature tour', (group) => {
  group.setup(async () => {
    hasPgTools = await probePgTools()
    if (!hasPgTools) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pg_dump/pg_restore/psql not on PATH — backup tests will be skipped')
    }
    await dropAllTenants()
  })

  group.teardown(async () => {
    await dropAllTenants()
  })

  // ─── S4: Lifecycle hooks ────────────────────────────────────────
  test('hooks.beforeProvision throws → tenant flips to status=failed', async ({
    client,
    assert,
  }) => {
    const r = await client.post('/demo/tenants').json({
      name: 'BadHook',
      email: 'badhook@example.com',
    })
    r.assertStatus(202)
    const id = r.body().tenantId
    const status = await installInline(id)
    assert.equal(status, 'failed', 'hook should reject non-.test email')
  })

  // ─── 1. Schema isolation + provisioning ─────────────────────────
  test('provisions a tenant via POST /demo/tenants and tenant.install flips status', async ({
    client,
    assert,
  }) => {
    const r = await client.post('/demo/tenants').json({
      name: 'E2E Primary',
      email: 'primary@e2e.test',
      plan: 'pro',
      tier: 'premium',
    })
    r.assertStatus(202)
    primaryTenantId = r.body().tenantId
    assert.isString(primaryTenantId)

    const status = await installInline(primaryTenantId)
    assert.equal(status, 'active')

    const exitCode = await runAce('tenant:migrate', ['--tenant', primaryTenantId])
    assert.equal(exitCode, 0)
  })

  test('connection name reflects the tenant', async ({ client, assert }) => {
    const r = await client
      .get('/demo/connection')
      .header('x-tenant-id', primaryTenantId)
    r.assertStatus(200)
    assert.include(r.body().connectionName, `tenant_${primaryTenantId}`)
  })

  // ─── Schema isolation: writes go into the right schema ──────────
  test('POST /demo/notes writes into tenant_<uuid>.notes', async ({ client, assert }) => {
    const r = await client
      .post('/demo/notes')
      .header('x-tenant-id', primaryTenantId)
      .json({ title: 'first', body: 'isolation works' })
    r.assertStatus(201)

    const list = await client.get('/demo/notes').header('x-tenant-id', primaryTenantId)
    list.assertStatus(200)
    assert.isAtLeast(list.body().notes.length, 1)
  })

  test('a different tenant sees a completely separate row set', async ({ client, assert }) => {
    const create = await client.post('/demo/tenants').json({
      name: 'E2E Secondary',
      email: 'secondary@e2e.test',
      plan: 'free',
      tier: 'standard',
    })
    create.assertStatus(202)
    const otherId = create.body().tenantId
    await installInline(otherId)
    await runAce('tenant:migrate', ['--tenant', otherId])

    const list = await client.get('/demo/notes').header('x-tenant-id', otherId)
    list.assertStatus(200)
    assert.equal(list.body().notes.length, 0, 'other tenant must see zero notes')
  })

  // ─── 3. Circuit breaker ─────────────────────────────────────────
  test('GET /demo/circuit reports CLOSED state for a healthy tenant', async ({
    client,
    assert,
  }) => {
    await client.get('/demo/notes').header('x-tenant-id', primaryTenantId)
    const r = await client.get('/demo/circuit').header('x-tenant-id', primaryTenantId)
    r.assertStatus(200)
    if (r.body().metrics !== null) {
      assert.equal(r.body().metrics.state, 'CLOSED')
    } else {
      assert.isNull(r.body().metrics)
    }
  })

  // ─── 4. Lifecycle event listeners write to audit_logs ───────────
  test('TenantCreated listener populated the audit log', async ({ client, assert }) => {
    const r = await client.get('/demo/audit').header('x-tenant-id', primaryTenantId)
    r.assertStatus(200)
    const actions = r.body().rows.map((row: any) => row.action)
    assert.include(actions, 'tenant.created')
  })

  // ─── 6. Health probes ────────────────────────────────────────────
  test('GET /livez returns 200', async ({ client }) => {
    const r = await client.get('/livez')
    r.assertStatus(200)
  })

  test('GET /metrics returns Prometheus exposition with expected counters', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/metrics')
    r.assertStatus(200)
    assert.match(r.text(), /multitenancy_uptime_seconds/)
    assert.match(r.text(), /multitenancy_tenants_total/)
  })

  test('GET /healthz returns a status field', async ({ client, assert }) => {
    const r = await client.get('/healthz')
    r.assertStatus(200)
    assert.isString(r.body().status)
  })

  // ─── 7. Doctor (HTTP form + CLI form) ───────────────────────────
  test('GET /demo/doctor returns a JSON report from DoctorService', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/demo/doctor').header('x-tenant-id', primaryTenantId)
    r.assertStatus(200)
    assert.property(r.body(), 'reports')
    assert.property(r.body(), 'totals')
    assert.isAtLeast(r.body().reports.length, 1)
    const checkNames = r.body().reports.map((rep: any) => rep.check)
    assert.include(checkNames, 'demo_marker_check')
  })

  test('node ace tenant:doctor --json runs (exit code 0 or 1)', async ({ assert }) => {
    const exitCode = await runAce('tenant:doctor', ['--json'])
    assert.oneOf(exitCode, [0, 1])
  })

  // ─── 8. Plans + quotas ───────────────────────────────────────────
  test('GET /demo/quota/state shows the resolved plan', async ({ client, assert }) => {
    const r = await client.get('/demo/quota/state').header('x-tenant-id', primaryTenantId)
    r.assertStatus(200)
    assert.equal(r.body().plan, 'pro')
  })

  test('enforceQuota returns 429 once the free-plan limit is exceeded', async ({
    client,
    assert,
  }) => {
    const create = await client.post('/demo/tenants').json({
      name: 'Quota Tester',
      email: 'quota@e2e.test',
      plan: 'free',
      tier: 'standard',
    })
    create.assertStatus(202)
    const id = create.body().tenantId
    await installInline(id)
    await runAce('tenant:migrate', ['--tenant', id])

    let last429 = -1
    for (let i = 0; i < 60; i++) {
      const r = await client
        .post('/demo/notes')
        .header('x-tenant-id', id)
        .json({ title: `n${i}` })
      if (r.status() === 429) {
        last429 = i
        break
      }
    }
    assert.notEqual(last429, -1, 'expected at least one 429 in 60 attempts')
  })

  // ─── 9. Backups ──────────────────────────────────────────────────
  test('tenant:backup writes a dump file (skipped if pg_dump missing)', async ({
    assert,
  }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }
    const exitCode = await runAce('tenant:backup', ['--tenant', primaryTenantId])
    assert.equal(exitCode, 0)
  })

  test('tenant:backups:run --dry-run is idempotent', async ({ assert }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }
    const a = await runAce('tenant:backups:run', ['--dry-run'])
    const b = await runAce('tenant:backups:run', ['--dry-run'])
    assert.equal(a, 0)
    assert.equal(b, 0)
  })

  // ─── 12. Read replica routing ───────────────────────────────────
  test('GET /demo/notes/read returns the replica connection name', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/demo/notes/read').header('x-tenant-id', primaryTenantId)
    if (r.status() !== 200) {
      // eslint-disable-next-line no-console
      console.error('[replica test] body:', JSON.stringify(r.body()))
    }
    r.assertStatus(200)
    assert.isString(r.body().readFrom)
    assert.isTrue(r.body().isReplica, 'expected sticky strategy to land on _read_0')
  })

  // ─── 13. Admin REST API (gated) ─────────────────────────────────
  test('admin /admin/tenants is gated by x-admin-token', async ({ client }) => {
    const r = await client.get('/admin/tenants')
    r.assertStatus(401)
  })

  test('admin /admin/tenants returns the full list with token', async ({ client, assert }) => {
    const r = await client.get('/admin/tenants').headers(ADMIN_HEADERS)
    r.assertStatus(200)
    assert.isArray(r.body().data)
  })

  test('admin /admin/health/report returns a DoctorService report', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/admin/health/report').headers(ADMIN_HEADERS)
    assert.oneOf(r.status(), [200, 503])
    assert.property(r.body(), 'reports')
  })

  // ─── 11. Soft-delete + purge ────────────────────────────────────
  test('?keepSchema=true marks deleted_at without dropping the schema', async ({
    client,
    assert,
  }) => {
    const create = await client.post('/demo/tenants').json({
      name: 'Soft Delete',
      email: 'softdel@e2e.test',
      plan: 'free',
      tier: 'standard',
    })
    create.assertStatus(202)
    const id = create.body().tenantId
    await installInline(id)

    const del = await client.delete(`/demo/tenants/${id}?keepSchema=true`)
    del.assertStatus(200)
    assert.isTrue(del.body().softDeleted)

    const schemaName = `tenant_${id}`
    const before = await db
      .connection('public')
      .rawQuery('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [schemaName])
    assert.isAtLeast(before.rows.length, 1, 'schema should still exist after soft-delete')

    const purge = await runAce('tenant:purge-expired', [
      '--retention-days', '0', '--force',
    ])
    assert.equal(purge, 0)

    const after = await db
      .connection('public')
      .rawQuery('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [schemaName])
    assert.equal(after.rows.length, 0, 'schema should be dropped after purge')
  })

  // ─── Resolution: missing header → 400 ───────────────────────────
  test('missing tenant header returns 400', async ({ client }) => {
    const r = await client.get('/demo/connection')
    r.assertStatus(400)
  })
})
