import { test } from '@japa/runner'
import BackupService from '../../../src/services/backup_service.js'

/**
 * Unit coverage for the filename security gate. `restore()` and
 * `deleteBackup()` validate `fileName` against a strict `.dump` pattern
 * BEFORE touching the filesystem / config, so this runs without a booted app.
 * The gate is the line of defence against path traversal into the backup dir.
 */
test.group('BackupService — backup filename validation', () => {
  const svc = new BackupService()
  const tenant = { id: 't', schemaName: 'tenant_x' } as any

  const unsafeNames = [
    '../etc/passwd',
    '..\\..\\windows\\system32',
    'subdir/evil.dump',
    'evil\\nested.dump',
    'name with spaces.dump',
    'no-extension',
    'archive.dump.txt',
    'archive.tar.gz',
    "'; DROP TABLE x; --.dump",
    '',
  ]

  for (const name of unsafeNames) {
    test(`restore rejects unsafe filename ${JSON.stringify(name)}`, async ({ assert }) => {
      await assert.rejects(() => svc.restore(tenant, name), /Invalid backup file name/)
    })

    test(`deleteBackup rejects unsafe filename ${JSON.stringify(name)}`, async ({ assert }) => {
      await assert.rejects(() => svc.deleteBackup('t', name), /Invalid backup file name/)
    })
  }

  test('a well-formed .dump filename passes the validation gate', async ({ assert }) => {
    // Our own producer's format: tenant_<id>_<ts>.dump. A valid name passes
    // the pattern check, then fails downstream (no config/IO) — the point is
    // it is NOT rejected as an invalid filename.
    const valid = 'tenant_abcd_2026-05-02T16-16-36-264Z.dump'
    let message = ''
    try {
      await svc.deleteBackup('t', valid)
    } catch (err) {
      message = (err as Error)?.message ?? ''
    }
    assert.notMatch(message, /Invalid backup file name/, 'valid name passed the gate')
  })
})
