import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import redis from '@adonisjs/redis/services/main'
import {
  withTenantOperationLock,
  TenantOperationLockedException,
  tenantOperationLockKey,
} from '@adonisjs-lasagna/backup'

/**
 * HARDENING: backup/restore concurrency lock.
 *
 * Backup, restore, clone, and import now run under a per-tenant Redis lock
 * (`withTenantOperationLock`, used inside BackupService/CloneService/
 * SqlImportService). Two backup-family operations on the same tenant can corrupt
 * each other (a dump reading a schema mid-`pg_restore --clean`), so the second
 * concurrent caller is rejected fast with `TenantOperationLockedException`
 * rather than allowed to overlap. Operations on DIFFERENT tenants never block
 * each other.
 *
 * This exercises the lock primitive the services use, directly against the live
 * Redis, so it is deterministic and needs no pg tools. The command/job paths
 * inherit it because both delegate to those services.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.group('hardening — backup/restore concurrency lock', (group) => {
  const used: string[] = []
  group.teardown(async () => {
    // Locks auto-release in their own finally; clean up defensively anyway.
    await Promise.all(used.map((id) => redis.del(tenantOperationLockKey(id)).catch(() => {})))
  })

  test('two concurrent operations on the same tenant → exactly one wins', async ({ assert }) => {
    const tenantId = randomUUID()
    used.push(tenantId)
    let ran = 0
    const op = async () => {
      ran++
      await delay(150) // hold the lock so the sibling collides while we own it
      return 'ok'
    }

    const results = await Promise.allSettled([
      withTenantOperationLock(tenantId, 'backup', op),
      withTenantOperationLock(tenantId, 'restore', op),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    assert.lengthOf(fulfilled, 1, 'exactly one operation may run')
    assert.lengthOf(rejected, 1, 'the second concurrent operation must be rejected')
    assert.instanceOf(
      rejected[0]!.reason,
      TenantOperationLockedException,
      'the rejection must be the typed lock exception'
    )
    assert.equal((rejected[0]!.reason as TenantOperationLockedException).status, 409)
    assert.equal(ran, 1, 'only the lock winner executes its operation body — no overlap')
  }).timeout(15_000)

  test('operations on different tenants do not block each other', async ({ assert }) => {
    const a = randomUUID()
    const b = randomUUID()
    used.push(a, b)
    let ran = 0
    const op = async () => {
      ran++
      await delay(50)
      return 'ok'
    }

    const results = await Promise.allSettled([
      withTenantOperationLock(a, 'backup', op),
      withTenantOperationLock(b, 'backup', op),
    ])

    assert.isTrue(
      results.every((r) => r.status === 'fulfilled'),
      'distinct tenants hold distinct locks and both proceed'
    )
    assert.equal(ran, 2, 'both operations run')
  }).timeout(15_000)

  test('the lock is released after completion — a later op on the same tenant succeeds', async ({
    assert,
  }) => {
    const tenantId = randomUUID()
    used.push(tenantId)

    const first = await withTenantOperationLock(tenantId, 'backup', async () => 'first')
    assert.equal(first, 'first')

    // The key must be gone immediately after the first op releases it.
    assert.isNull(
      await redis.get(tenantOperationLockKey(tenantId)),
      'lock key must be deleted on release'
    )

    const second = await withTenantOperationLock(tenantId, 'restore', async () => 'second')
    assert.equal(second, 'second', 'a sequential op acquires the freed lock')
  })
})
