import { test } from '@japa/runner'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
    .sort()
  return files.length === 0 ? null : files[files.length - 1]
}

/**
 * Failure-case counterpart to backups_real.spec.ts: restoring from a
 * corrupted archive must fail LOUDLY (the promise behind "restore" in the
 * docs) and must not leave the tenant half-wiped. `pg_restore` reads the
 * custom-format TOC before it executes any `--clean` statement, so a
 * garbled header aborts before touching the schema.
 */
test.group('e2e — restore from a corrupted backup fails loudly, schema intact', (group) => {
  group.setup(async () => {
    hasPgTools = await probePgTools()
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('corrupted dump → restore rejects and the live schema keeps its rows', async ({
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
      .json({ title: 'survives-corrupt-restore', body: 'one' })
    await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'survives-corrupt-restore', body: 'two' })

    assert.equal(await runAce('tenant:backup', ['--tenant', id]), 0)

    const storagePath = await getStoragePath()
    const file = findBackupFile(storagePath, id)
    assert.isNotNull(file, 'backup must exist before we can corrupt it')

    // Garble the archive: overwrite it with junk that is not a pg_dump
    // custom-format header. pg_restore must refuse it outright.
    writeFileSync(join(storagePath, id, file!), 'this is not a postgres dump\n'.repeat(8))

    const tenant = await Tenant.findOrFail(id)
    const svc = new BackupService()
    // No third argument: @japa/assert's rejects() reads it as the expected
    // error substring, not as an assertion label.
    await assert.rejects(() => svc.restore(tenant as any, file!), /pg_restore/i)

    const after = await client.get('/demo/notes').header('x-tenant-id', id)
    after.assertStatus(200)
    assert.equal(
      after.body().notes.length,
      2,
      'the failed restore must not have dropped or partially wiped the live schema'
    )
  })
})
