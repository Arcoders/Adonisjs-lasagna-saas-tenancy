import { test } from '@japa/runner'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertRewriteLiteralSafety } from '../../../../src/services/sql_import_service.js'
import { assertRegularFile } from '../../../../src/services/fs_guards.js'
import {
  withTenantOperationLock,
  TenantOperationLockUnavailableException,
} from '../../../../src/services/tenant_operation_lock.js'
import { evaluateBackupEncryption } from '../../../../src/doctor/backup_encryption_check.js'

/**
 * Unit coverage for the B-BACKUP hardening: the SQL-import literal-rewrite
 * refusal, the symlink guard, the lock fail-closed behaviour for destructive
 * operations, and the at-rest encryption advisory. These run in-process (no DB,
 * no Redis, no psql).
 */

test.group('B-BACKUP — SQL import literal-rewrite refusal', () => {
  test('refuses when a literal would be rewritten and force is off', ({ assert }) => {
    assert.throws(
      () =>
        assertRewriteLiteralSafety({
          suspectLiteralLines: ["INSERT INTO t (v) VALUES ('see public.foo');"],
          sourceSchema: 'public',
        }),
      /SQL import refused/
    )
  })

  test('allows the import when force is set', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertRewriteLiteralSafety({
        suspectLiteralLines: ["INSERT INTO t (v) VALUES ('see public.foo');"],
        sourceSchema: 'public',
        force: true,
      })
    )
  })

  test('does nothing when no literal is at risk', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertRewriteLiteralSafety({ suspectLiteralLines: [], sourceSchema: 'public' })
    )
  })
})

test.group('B-BACKUP — symlink guard', (group) => {
  let dir: string
  group.each.setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-symlink-'))
  })
  group.each.teardown(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('accepts a regular file', async ({ assert }) => {
    const file = join(dir, 'real.dump')
    await writeFile(file, 'data', 'utf-8')
    await assert.doesNotReject(() => assertRegularFile(file))
  })

  test('rejects a directory', async ({ assert }) => {
    await assert.rejects(() => assertRegularFile(dir), /not a regular file/)
  })

  test('rejects a symlink pointing outside the backup dir', async ({ assert }) => {
    const target = join(dir, 'real.dump')
    await writeFile(target, 'data', 'utf-8')
    const link = join(dir, 'link.dump')
    try {
      await symlink(target, link)
    } catch {
      // Symlink creation can fail without privilege (Windows). The Linux CI
      // exercises this path; skip locally when it is not permitted.
      return
    }
    await assert.rejects(() => assertRegularFile(link), /Refusing to use a symlink/)
  })
})

test.group('B-BACKUP — operation lock fail-closed for destructive ops', () => {
  // In a bare unit runner `@adonisjs/redis/services/main` is unavailable, so the
  // lock takes its Redis-down branch — exactly the condition failClosed governs.
  test('fails closed (throws) when Redis is unavailable and failClosed is set', async ({
    assert,
  }) => {
    await assert.rejects(
      () =>
        withTenantOperationLock(randomUUID(), 'restore', async () => 'ran', { failClosed: true }),
      /coordination layer is unreachable/
    )
  })

  test('the thrown error is the typed 503 exception', async ({ assert }) => {
    try {
      await withTenantOperationLock(randomUUID(), 'clone', async () => 'ran', { failClosed: true })
      assert.fail('expected the lock to throw')
    } catch (err) {
      assert.instanceOf(err, TenantOperationLockUnavailableException)
      assert.equal((err as TenantOperationLockUnavailableException).status, 503)
    }
  })

  test('fails open (runs without the lock) by default when Redis is unavailable', async ({
    assert,
  }) => {
    const result = await withTenantOperationLock(randomUUID(), 'backup', async () => 'ran')
    assert.equal(result, 'ran')
  })
})

test.group('B-BACKUP — at-rest encryption advisory', () => {
  test('flags S3 backups for bucket-level SSE', ({ assert }) => {
    const issues = evaluateBackupEncryption({ s3: { enabled: true } })
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'backup_s3_encryption_unverified')
  })

  test('flags local backups for disk encryption + permissions', ({ assert }) => {
    const issues = evaluateBackupEncryption({ storagePath: '/var/backups' })
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'backup_local_encryption_unverified')
    assert.include(issues[0].message, '/var/backups')
  })

  test('returns nothing when backup is not configured', ({ assert }) => {
    assert.isEmpty(evaluateBackupEncryption(undefined))
  })
})
