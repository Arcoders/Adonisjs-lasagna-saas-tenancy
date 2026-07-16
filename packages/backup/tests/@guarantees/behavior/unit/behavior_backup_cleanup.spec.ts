import { test } from '@japa/runner'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BackupService from '../../../../src/services/backup_service.js'

/**
 * A backup whose `pg_dump` dies mid-write must not leave a partial,
 * unrestorable .dump behind, otherwise a later `restore` or retention sweep
 * could pick the corrupt half-file as if it were a real backup.
 *
 * This drives the cleanup without a real Postgres by substituting `runProcess`
 * (the protected spawn seam): one stand-in writes a partial file then throws
 * (the failure path), another writes a complete file and returns (the success
 * path, to prove the cleanup never fires on a good dump). The backup lock fails
 * open without Redis, so `backup()` reaches `#backupLocked` directly here.
 */

function tenantDouble() {
  const id = randomUUID()
  return { id, schemaName: `tenant_${id}`, name: `t-${id.slice(0, 8)}` } as any
}

function dumpFilesIn(dir: string): Promise<string[]> {
  return readdir(dir)
    .then((names) => names.filter((n) => n.endsWith('.dump')))
    .catch(() => [])
}

// pg_dump that opens its --file output, writes a partial archive, then dies.
class PartialThenFailBackup extends BackupService {
  wrotePath?: string
  protected async runProcess(_command: string, args: string[]): Promise<void> {
    const i = args.indexOf('--file')
    this.wrotePath = args[i + 1]
    await writeFile(this.wrotePath, 'PARTIAL — not a valid pg_dump custom archive')
    throw new Error('pg_dump exited with code 1: server closed the connection unexpectedly')
  }
}

// pg_dump that completes and leaves a (fake) full archive at --file.
class CleanBackup extends BackupService {
  protected async runProcess(_command: string, args: string[]): Promise<void> {
    const i = args.indexOf('--file')
    await writeFile(args[i + 1], 'COMPLETE archive bytes')
  }
}

test.group('BackupService — partial-artifact cleanup on dump failure', (group) => {
  let storage: string

  group.each.setup(async () => {
    storage = await mkdtemp(join(tmpdir(), 'backup-cleanup-'))
    setConfig({
      backup: {
        storagePath: storage,
        metadataTtl: 86_400,
        pgConnection: {
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          password: '',
          database: 'test',
        },
      },
    } as never)
  })

  group.each.teardown(async () => {
    await rm(storage, { recursive: true, force: true })
  })

  test('a failed pg_dump removes the partial .dump it left behind', async ({ assert }) => {
    const svc = new PartialThenFailBackup()
    const tenant = tenantDouble()

    await assert.rejects(() => svc.backup(tenant), /pg_dump exited with code 1/)

    assert.isString(svc.wrotePath, 'precondition: the stand-in wrote a partial file')
    assert.isFalse(
      existsSync(svc.wrotePath!),
      'the partial dump must be unlinked when the backup fails'
    )
    assert.lengthOf(
      await dumpFilesIn(join(storage, tenant.id)),
      0,
      'no .dump artifact may survive a failed backup'
    )
  })

  test('a successful pg_dump keeps its artifact (cleanup never over-fires)', async ({ assert }) => {
    const svc = new CleanBackup()
    const tenant = tenantDouble()

    const meta = await svc.backup(tenant)

    assert.equal(meta.tenantId, tenant.id)
    assert.match(meta.file, /\.dump$/)
    assert.lengthOf(
      await dumpFilesIn(join(storage, tenant.id)),
      1,
      'the completed dump must remain on disk'
    )
    assert.isTrue(existsSync(join(storage, tenant.id, meta.file)))
  })
})
