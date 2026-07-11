import { test } from '@japa/runner'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import app from '@adonisjs/core/services/app'
import { BackupService } from '@adonisjs-lasagna/backup'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants, probePgTools, runAce } from './_helpers.js'

let hasPgTools = false

async function getStoragePath(): Promise<string> {
  const cfg = (await import('#config/multitenancy')).default as any
  return resolve(cfg.backup?.storagePath ?? './storage/backups')
}

function findBackupFile(storagePath: string, tenantId: string): string | null {
  const dir = join(storagePath, tenantId)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`tenant_${tenantId}_`) && f.endsWith('.dump'))
    .sort() // newest filename last
  return files.length === 0 ? null : files[files.length - 1]!
}

/**
 * A real round-trip through backup, restore, import, and clone. Every test starts
 * by checking pg_dump / pg_restore / psql are on PATH; if not, it skips with a
 * clear message so the suite remains rerunnable in environments without the
 * PostgreSQL client tools (e.g. minimal CI runners).
 */
test.group('e2e — backup, restore, import, clone (real)', (group) => {
  group.setup(async () => {
    hasPgTools = await probePgTools()
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('tenant:backup writes a .dump file under <storagePath>/<tenantId>/', async ({
    client,
    assert,
  }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const { id } = await createInstalledTenant(client)
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'pre-backup', body: 'one' })
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'pre-backup', body: 'two' })

    const code = await runAce('tenant:backup', ['--tenant', id])
    assert.equal(code, 0, 'tenant:backup should exit 0')

    const storagePath = await getStoragePath()
    const file = findBackupFile(storagePath, id)
    assert.isNotNull(file, 'expected at least one .dump file under the tenant storage dir')

    const fullPath = join(storagePath, id, file!)
    const fs = await import('node:fs')
    const stats = fs.statSync(fullPath)
    assert.isAbove(stats.size, 0, 'backup file should not be empty')
  })

  test('BackupService.restore round-trips the schema (skipped if pg tools missing)', async ({
    client,
    assert,
  }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const { id } = await createInstalledTenant(client)
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'before-restore', body: 'a' })
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'before-restore', body: 'b' })

    const backupCode = await runAce('tenant:backup', ['--tenant', id])
    assert.equal(backupCode, 0)

    const storagePath = await getStoragePath()
    const file = findBackupFile(storagePath, id)
    assert.isNotNull(file)

    // Mutate the schema after backup. Restore must overwrite back to 2 rows.
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'post-backup', body: 'c' })
    const beforeRestore = await client.get('/demo/notes').header('x-tenant-id', id)
    assert.equal(beforeRestore.body().notes.length, 3, 'mutation step expected 3 notes')

    // Drive restore via the service (the CLI command uses an interactive
    // prompt that doesn't survive in non-TTY).
    const tenant = await Tenant.findOrFail(id)
    const svc = new BackupService()
    await svc.restore(tenant as any, file!)

    const afterRestore = await client.get('/demo/notes').header('x-tenant-id', id)
    assert.equal(
      afterRestore.body().notes.length,
      2,
      'restore should roll the schema back to the snapshot'
    )
  })

  test('tenant:import applies the demo-tenant.sql fixture into the tenant schema', async ({
    client,
    assert,
  }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const { id } = await createInstalledTenant(client)
    const fixture = resolve('tests/fixtures/demo-tenant.sql')

    const code = await runAce('tenant:import', [
      '-t',
      id,
      '-f',
      fixture,
      '--schema-replace',
      'public',
      '--force',
    ])
    assert.equal(code, 0, 'tenant:import should exit 0')

    // The fixture creates a `widgets` table that is NOT in the per-tenant
    // migrations, so its presence proves the dump was rewritten and applied.
    const tenant = await Tenant.findOrFail(id)
    const conn = tenant.getConnection()
    const widgets = await conn.rawQuery('SELECT count(*)::int AS n FROM widgets')
    assert.equal(widgets.rows[0].n, 3, 'expected 3 widgets from the fixture')

    const notes = await conn.rawQuery(
      `SELECT count(*)::int AS n FROM notes WHERE title LIKE 'Imported %'`
    )
    assert.equal(notes.rows[0].n, 2, 'expected 2 imported notes from the fixture')
  })

  test('tenant:import --dry-run reports counts without mutating', async ({ client, assert }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const { id } = await createInstalledTenant(client)
    const fixture = resolve('tests/fixtures/demo-tenant.sql')

    const code = await runAce('tenant:import', [
      '-t',
      id,
      '-f',
      fixture,
      '--schema-replace',
      'public',
      '--dry-run',
      '--force',
    ])
    assert.equal(code, 0)

    // No widgets table should have been created.
    const tenant = await Tenant.findOrFail(id)
    const conn = tenant.getConnection()
    const exists = await conn.rawQuery(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = ? AND table_name = 'widgets'
       ) AS present`,
      [tenant.schemaName]
    )
    assert.isFalse(Boolean(exists.rows[0].present), 'dry-run should not create the widgets table')
  })

  test('tenant:clone copies schema + data into a new tenant', async ({ client, assert }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const source = await createInstalledTenant(client, { name: 'CloneSrcReal' })
    for (let i = 0; i < 5; i++) {
      const r = await client
        .post('/demo/notes')
        .header('x-tenant-id', source.id)
        .json({ title: `src-${i}`, body: `body ${i}` })
      r.assertStatus(201)
    }

    // Sanity: source schema actually has the 5 rows we just inserted.
    const sourceTenant = await Tenant.findOrFail(source.id)
    const srcCount = await sourceTenant
      .getConnection()
      .rawQuery('SELECT count(*)::int AS n FROM notes')
    assert.equal(srcCount.rows[0].n, 5, 'source schema should have 5 notes before clone')

    const stamp = Date.now().toString(36)
    const code = await runAce('tenant:clone', [
      '--source',
      source.id,
      '--name',
      `Cloned-${stamp}`,
      '--email',
      `cloned-${stamp}@e2e.test`,
    ])
    assert.equal(code, 0, 'tenant:clone should exit 0')

    const dest = await Tenant.query().where('email', `cloned-${stamp}@e2e.test`).firstOrFail()
    assert.equal(dest.status, 'active', 'destination should be active after clone')

    // Cross-check via three independent reads. If they disagree, the failure
    // mode is observable instead of opaque. Past failures here have all
    // looked identical (count = 0) so the only way to debug from CI is to
    // know whether the data is actually missing or just hidden by
    // connection-pool / search-path quirks.
    const dbSvc = (await import('@adonisjs/lucid/services/db')).default
    const central = dbSvc.connection('public')

    const viaCentral = await central.rawQuery(
      `SELECT count(*)::int AS n FROM "${dest.schemaName}".notes`
    )
    const viaCentralFq = await central.rawQuery(
      `SELECT count(*)::int AS n FROM "${dest.schemaName}"."notes"`
    )
    const tablesInDst = await central.rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename`,
      [dest.schemaName]
    )
    const tablesInSrc = await central.rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename`,
      [sourceTenant.schemaName]
    )
    const sourceVisible = await central.rawQuery(
      `SELECT count(*)::int AS n FROM "${sourceTenant.schemaName}"."notes"`
    )

    assert.equal(
      viaCentral.rows[0].n,
      5,
      `cloned schema should carry the source rows. ` +
        `via central (unqual): ${viaCentral.rows[0].n}, ` +
        `via central (quoted): ${viaCentralFq.rows[0].n}, ` +
        `dst tables: ${tablesInDst.rows.map((r: any) => r.tablename).join(',')}, ` +
        `src tables: ${tablesInSrc.rows.map((r: any) => r.tablename).join(',')}, ` +
        `src.notes count via central: ${sourceVisible.rows[0].n}`
    )
  })

  test('tenant:clone --schema-only copies structure but no rows', async ({ client, assert }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const source = await createInstalledTenant(client, { name: 'CloneSrcStruct' })
    await client
      .post('/demo/notes')
      .header('x-tenant-id', source.id)
      .json({ title: 'should-not-clone', body: '...' })

    const stamp = Date.now().toString(36) + '-struct'
    const code = await runAce('tenant:clone', [
      '--source',
      source.id,
      '--name',
      `Struct-${stamp}`,
      '--email',
      `struct-${stamp}@e2e.test`,
      '--schema-only',
    ])
    assert.equal(code, 0)

    const dest = await Tenant.query().where('email', `struct-${stamp}@e2e.test`).firstOrFail()
    const dbSvc = (await import('@adonisjs/lucid/services/db')).default
    const central = dbSvc.connection('public')
    const result = await central.rawQuery(
      `SELECT count(*)::int AS n FROM "${dest.schemaName}".notes`
    )
    assert.equal(result.rows[0].n, 0, '--schema-only should leave the destination empty')
  })

  test('BackupService is bindable from the IoC container', async ({ assert }) => {
    // Smoke check that the service is registered the way other tests expect.
    const svc = await app.container.make(BackupService)
    assert.instanceOf(svc, BackupService)
  })
})
