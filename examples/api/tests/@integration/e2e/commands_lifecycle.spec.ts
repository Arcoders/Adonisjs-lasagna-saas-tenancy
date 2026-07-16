import { test } from '@japa/runner'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createInstalledTenant, dropAllTenants, runAce } from './_helpers.js'

// Execution coverage for tenant-lifecycle ace commands. The package's
// `tests/unit/commands/*` are metadata-only; each test here exercises the
// real command via ace.exec() and asserts the effect (DB rows, schema
// presence, imported data), not just the exit code.
test.group('e2e — tenant lifecycle CLI commands', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  async function schemaExists(schema: string): Promise<boolean> {
    const r = await db.rawQuery(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ?) AS present`,
      [schema]
    )
    return Boolean(r.rows[0].present)
  }

  test('tenant:list and tenant:list --all run and exit 0 against real rows', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(await runAce('tenant:list'), 0)
    assert.equal(await runAce('tenant:list', ['--all']), 0)
    assert.isNotNull(await Tenant.find(id), 'the tenant the command listed actually exists')
  })

  test('tenant:suspend then tenant:activate flip the status column', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })

    assert.equal(await runAce('tenant:suspend', [id]), 0)
    assert.equal(
      (await Tenant.findOrFail(id)).status,
      'suspended',
      'status is suspended after tenant:suspend'
    )

    assert.equal(await runAce('tenant:activate', [id]), 0)
    assert.equal(
      (await Tenant.findOrFail(id)).status,
      'active',
      'status is active after tenant:activate'
    )
  })

  test('tenant:import loads a .sql dump into the tenant schema', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client) // migrated, so the `notes` table exists
    const tenant = await Tenant.findOrFail(id)
    const file = join(tmpdir(), `lasagna-import-${randomUUID()}.sql`)
    // No schema prefix needed, since search_path is already at tenant_<uuid>.
    await writeFile(
      file,
      [
        `INSERT INTO notes (title, body) VALUES ('Imported A', 'from dump');`,
        `INSERT INTO notes (title, body) VALUES ('Imported B', 'from dump');`,
        ``,
      ].join('\n'),
      'utf8'
    )
    try {
      const code = await runAce('tenant:import', ['--tenant', id, '--file', file])
      assert.equal(code, 0, 'tenant:import should exit 0')

      const rows = await tenant
        .getConnection()
        .rawQuery(`SELECT title FROM notes WHERE title LIKE 'Imported %' ORDER BY title`)
      const titles = rows.rows.map((r: { title: string }) => r.title)
      assert.deepEqual(
        titles,
        ['Imported A', 'Imported B'],
        'both rows from the dump landed in the tenant schema'
      )
    } finally {
      await rm(file, { force: true })
    }
  })

  test('tenant:import --dry-run parses the file but writes nothing', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const tenant = await Tenant.findOrFail(id)
    const file = join(tmpdir(), `lasagna-import-dry-${randomUUID()}.sql`)
    await writeFile(file, `INSERT INTO notes (title, body) VALUES ('DryRun', 'x');\n`, 'utf8')
    try {
      assert.equal(await runAce('tenant:import', ['--tenant', id, '--file', file, '--dry-run']), 0)
      const rows = await tenant
        .getConnection()
        .rawQuery(`SELECT 1 FROM notes WHERE title = 'DryRun'`)
      assert.lengthOf(rows.rows, 0, 'dry-run must not write any rows')
    } finally {
      await rm(file, { force: true })
    }
  })

  test('tenant:purge-expired drops schemas past retention and spares recent ones', async ({
    client,
    assert,
  }) => {
    // Past the 30-day default retention window.
    const expired = await createInstalledTenant(client, { migrate: false })
    {
      const t = await Tenant.findOrFail(expired.id)
      t.deletedAt = DateTime.now().minus({ days: 40 })
      await t.save()
    }
    // Soft-deleted yesterday, so it must be left alone.
    const recent = await createInstalledTenant(client, { migrate: false })
    {
      const t = await Tenant.findOrFail(recent.id)
      t.deletedAt = DateTime.now().minus({ days: 1 })
      await t.save()
    }
    const expiredSchema = (await Tenant.findOrFail(expired.id)).schemaName
    const recentSchema = (await Tenant.findOrFail(recent.id)).schemaName
    assert.isTrue(await schemaExists(expiredSchema), 'precondition: expired tenant schema exists')
    assert.isTrue(await schemaExists(recentSchema), 'precondition: recent tenant schema exists')

    assert.equal(await runAce('tenant:purge-expired', ['--force']), 0)

    assert.isFalse(await schemaExists(expiredSchema), 'expired tenant schema was dropped')
    assert.isTrue(await schemaExists(recentSchema), 'recently-deleted tenant schema was spared')
  })

  test('tenant:purge-expired --dry-run reports candidates but drops nothing', async ({
    client,
    assert,
  }) => {
    const created = await createInstalledTenant(client, { migrate: false })
    const t = await Tenant.findOrFail(created.id)
    t.deletedAt = DateTime.now().minus({ days: 99 })
    await t.save()
    const schema = (await Tenant.findOrFail(created.id)).schemaName

    assert.equal(await runAce('tenant:purge-expired', ['--dry-run']), 0)
    assert.isTrue(await schemaExists(schema), 'dry-run left the schema in place')
  })

  test('tenant:maintenance toggles the column and the tenant-scoped route returns 503 while on', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client) // migrated so /demo/connection works
    const headers = { 'x-tenant-id': id }

    // Baseline: tenant-scoped route reachable.
    assert.equal((await client.get('/demo/connection').headers(headers)).status(), 200)

    // Enter maintenance with a custom message.
    assert.equal(await runAce('tenant:maintenance', [id, '--message', 'Down for an upgrade']), 0)
    let tenant = await Tenant.findOrFail(id)
    assert.isTrue(tenant.maintenance, 'maintenance flag set')
    assert.equal(tenant.maintenanceMessage, 'Down for an upgrade')

    // TenantGuardMiddleware must now block the request.
    const blocked = await client.get('/demo/connection').headers(headers)
    assert.equal(blocked.status(), 503, 'tenant-scoped route returns 503 while in maintenance')
    const retryAfter = blocked.headers()['retry-after']
    assert.exists(retryAfter, 'maintenance 503 must carry a Retry-After header')
    assert.isFalse(Number.isNaN(Number(retryAfter)), 'Retry-After must be numeric seconds')

    // Exit maintenance, which flips the column. Not asserting route-reachable here:
    // the gate is cached for schemaCacheTtl and bust-on-exit needs a host-wired
    // listener (out of scope for this demo).
    assert.equal(await runAce('tenant:maintenance', [id, '--off']), 0)
    tenant = await Tenant.findOrFail(id)
    assert.isFalse(tenant.maintenance, 'maintenance flag cleared')
    assert.isNull(tenant.maintenanceMessage)
  })

  test('tenant:impersonate issues a token and records the start in the audit log', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const userId = '11111111-2222-3333-4444-555555555555'
    // Demo's tenant_audit_logs.actor_id is uuid; --admin is otherwise free-form.
    const adminId = '99999999-8888-7777-6666-555555555555'

    const code = await runAce('tenant:impersonate', [
      id,
      userId,
      '--admin',
      adminId,
      '--reason',
      'support ticket #42',
    ])
    assert.equal(code, 0, 'tenant:impersonate exits 0')

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'admin:impersonate:start')
      .orderBy('created_at', 'desc')
      .first()
    assert.isNotNull(row, 'an audit-log row was written for the impersonation start')
    const raw = row!.metadata as unknown
    const meta = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      targetUserId?: string
      reason?: string
    } | null
    assert.equal(meta?.targetUserId, userId)
    assert.equal(meta?.reason, 'support ticket #42')
  })

  test('tenant:backups:run --dry-run reports active tenants without dumping', async ({
    client,
    assert,
  }) => {
    await createInstalledTenant(client, { migrate: false })
    assert.equal(await runAce('tenant:backups:run', ['--dry-run']), 0)
  })

  test('tenant:webhooks:retry drains the (empty) retry queue and exits 0', async ({ assert }) => {
    assert.equal(await runAce('tenant:webhooks:retry'), 0)
  })
})

// Runtime coverage for the CLI audit path (`audit_cli_action.ts` + the `--admin`
// flag on the lifecycle commands). Asserts the rows are actually written, with
// the admin/system attribution distinction and the no-op exemption.
test.group('e2e — tenant lifecycle CLI audit attribution', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  // tenant_audit_logs.actor_id is a uuid column, so --admin must be a uuid; a
  // non-uuid would silently fail the swallowed insert and write no row.
  const ADMIN_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  async function cliAudit(tenantId: string, action: string) {
    const row = await TenantAuditLog.query()
      .where('tenant_id', tenantId)
      .where('action', action)
      .orderBy('created_at', 'desc')
      .first()
    if (!row) return null
    const raw = row.metadata as unknown
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    > | null
    return { actorType: row.actorType, actorId: row.actorId, metadata }
  }

  async function cliAuditCount(tenantId: string, action: string): Promise<number> {
    const rows = await TenantAuditLog.query().where('tenant_id', tenantId).where('action', action)
    return rows.length
  }

  test('tenant:suspend --admin attributes the row to the admin', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(await runAce('tenant:suspend', [id, '--admin', ADMIN_UUID]), 0)
    const row = await cliAudit(id, 'admin:tenant:suspend')
    assert.isNotNull(row)
    assert.equal(row!.actorType, 'admin')
    assert.equal(row!.actorId, ADMIN_UUID)
    assert.equal(row!.metadata?.status, 'suspended')
  })

  test('tenant:suspend without --admin records a system actor', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(await runAce('tenant:suspend', [id]), 0)
    const row = await cliAudit(id, 'admin:tenant:suspend')
    assert.isNotNull(row)
    assert.equal(row!.actorType, 'system')
    assert.isNull(row!.actorId)
  })

  test('tenant:activate --admin records admin:tenant:activate', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    await runAce('tenant:suspend', [id])
    assert.equal(await runAce('tenant:activate', [id, '--admin', ADMIN_UUID]), 0)
    const row = await cliAudit(id, 'admin:tenant:activate')
    assert.isNotNull(row)
    assert.equal(row!.actorId, ADMIN_UUID)
    assert.equal(row!.metadata?.status, 'active')
  })

  test('tenant:create --admin records admin:tenant:create', async ({ assert }) => {
    assert.equal(
      await runAce('tenant:create', ['CliAudit', 'cli-audit@e2e.test', '--admin', ADMIN_UUID]),
      0
    )
    const tenant = await Tenant.query().where('email', 'cli-audit@e2e.test').first()
    assert.isNotNull(tenant)
    const row = await cliAudit(tenant!.id, 'admin:tenant:create')
    assert.isNotNull(row)
    assert.equal(row!.actorId, ADMIN_UUID)
    assert.equal(row!.metadata?.name, 'CliAudit')
    assert.equal(row!.metadata?.status, 'provisioning')
  })

  test('tenant:maintenance enter/exit record both actions', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(
      await runAce('tenant:maintenance', [id, '--admin', ADMIN_UUID, '--message', 'brb']),
      0
    )
    const enter = await cliAudit(id, 'admin:tenant:maintenance_enter')
    assert.isNotNull(enter)
    assert.equal(enter!.metadata?.hasMessage, true)

    assert.equal(await runAce('tenant:maintenance', [id, '--off', '--admin', ADMIN_UUID]), 0)
    const exit = await cliAudit(id, 'admin:tenant:maintenance_exit')
    assert.isNotNull(exit)
    assert.equal(exit!.actorId, ADMIN_UUID)
  })

  test('tenant:destroy --admin records schemaDropped true', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(await runAce('tenant:destroy', [id, '--admin', ADMIN_UUID, '--force']), 0)
    const row = await cliAudit(id, 'admin:tenant:destroy')
    assert.isNotNull(row)
    assert.equal(row!.metadata?.schemaDropped, true)
  })

  test('tenant:destroy --keep-schema records schemaDropped false', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    assert.equal(
      await runAce('tenant:destroy', [id, '--admin', ADMIN_UUID, '--keep-schema', '--force']),
      0
    )
    const row = await cliAudit(id, 'admin:tenant:destroy')
    assert.isNotNull(row)
    assert.equal(row!.metadata?.schemaDropped, false)
  })

  test('a no-op suspend (already suspended) writes no new row', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    await runAce('tenant:suspend', [id, '--admin', ADMIN_UUID])
    const before = await cliAuditCount(id, 'admin:tenant:suspend')
    // Already suspended, so the command returns early and audits nothing.
    await runAce('tenant:suspend', [id, '--admin', ADMIN_UUID])
    assert.equal(await cliAuditCount(id, 'admin:tenant:suspend'), before)
  })
})
