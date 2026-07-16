import { test } from '@japa/runner'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { BackupService } from '@adonisjs-lasagna/backup'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants, probePgTools } from './_helpers.js'

/**
 * End-to-end counterpart to the backup-cleanup unit spec: a real `pg_dump`
 * failure must leave no .dump artifact behind. We force the failure by pointing
 * pg_dump at a closed port (a real connection error mid-run, the same shape a
 * dropped DB connection produces), then assert the tenant's backup directory has
 * no orphaned dump for a later restore or retention sweep to mistake for a real
 * backup. The unit spec proves the cleanup logic with a stubbed process; this
 * proves it against the real binary.
 */
test.group('e2e — a failed backup leaves no corrupt artifact', (group) => {
  let hasPgTools = false

  group.setup(async () => {
    hasPgTools = await probePgTools()
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  async function storagePath(): Promise<string> {
    const cfg = (await import('#config/multitenancy')).default as any
    return resolve(cfg.backup?.storagePath ?? './storage/backups')
  }

  function dumpFiles(sp: string, tenantId: string): string[] {
    const dir = join(sp, tenantId)
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.dump')) : []
  }

  test('a pg_dump that fails mid-run removes the partial dump (no orphan)', async ({
    client,
    assert,
  }) => {
    if (!hasPgTools) {
      assert.isTrue(true, 'skipped — pg tools not on PATH')
      return
    }

    const { id } = await createInstalledTenant(client, { migrate: false })
    const tenant = await Tenant.findOrFail(id)
    const sp = await storagePath()
    assert.lengthOf(dumpFiles(sp, id), 0, 'precondition: no backups yet')

    // Force the dump to fail by pointing pg_dump at a closed port. pg_dump may
    // open its --file output before the connection is refused, so this exercises
    // the real partial-file path; the config is restored in `finally`.
    const cfg = getConfig()
    setConfig({
      ...cfg,
      backup: { ...cfg.backup, pgConnection: { ...cfg.backup!.pgConnection, port: 1 } },
    } as never)
    try {
      const svc = new BackupService()
      await assert.rejects(() => svc.backup(tenant as any), /pg_dump|exited|connect|refused/i)
    } finally {
      setConfig(cfg)
    }

    assert.lengthOf(
      dumpFiles(sp, id),
      0,
      'a failed backup must not leave a .dump behind for restore/retention to pick up'
    )
  })
})
