import { test } from '@japa/runner'
import BackupRetentionService from '../../../src/services/backup_retention_service.js'
import type BackupService from '../../../src/services/backup_service.js'
import type { BackupMetadata } from '../../../src/services/backup_service.js'
import { buildTestTenant } from '../../../src/testing/builders.js'
import { setupTestConfig, testConfig } from '../../helpers/config.js'

interface FakeBackupServiceCalls {
  listed: string[]
  deleted: Array<{ tenantId: string; file: string }>
}

function makeBackups(initial: Record<string, BackupMetadata[]> = {}): {
  service: BackupService
  calls: FakeBackupServiceCalls
} {
  const calls: FakeBackupServiceCalls = { listed: [], deleted: [] }
  const store = { ...initial }
  const service = {
    async listBackups(tenantId: string): Promise<BackupMetadata[]> {
      calls.listed.push(tenantId)
      return store[tenantId] ?? []
    },
    async deleteBackup(tenantId: string, file: string): Promise<void> {
      calls.deleted.push({ tenantId, file })
      store[tenantId] = (store[tenantId] ?? []).filter((m) => m.file !== file)
    },
  } as unknown as BackupService
  return { service, calls }
}

function meta(tenantId: string, file: string, hoursAgo: number): BackupMetadata {
  return {
    tenantId,
    file,
    size: 1024,
    schema: `tenant_${tenantId.replace(/-/g, '_')}`,
    timestamp: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  }
}

function setupRetention(tiers: Record<string, { intervalHours: number; keepLast: number }>, defaultTier = 'standard') {
  setupTestConfig({
    backup: {
      ...testConfig.backup,
      retention: {
        defaultTier,
        tiers,
      },
    },
  })
}

test.group('BackupRetentionService — getTierFor', () => {
  test('falls back to defaultTier when no resolver is configured', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } })
    const tenant = buildTestTenant()
    const svc = new BackupRetentionService(makeBackups().service)
    const tier = await svc.getTierFor(tenant)
    assert.deepEqual(tier, { intervalHours: 24, keepLast: 7 })
  })

  test('honors per-tenant getTier when provided', async ({ assert }) => {
    setupTestConfig({
      backup: {
        ...testConfig.backup,
        retention: {
          defaultTier: 'standard',
          tiers: {
            standard: { intervalHours: 24, keepLast: 7 },
            premium: { intervalHours: 6, keepLast: 60 },
          },
          getTier: (t) => (t.name.includes('VIP') ? 'premium' : undefined),
        },
      },
    })
    const svc = new BackupRetentionService(makeBackups().service)
    const vip = buildTestTenant({ name: 'VIP-1' })
    const std = buildTestTenant({ name: 'Acme' })
    assert.equal((await svc.getTierFor(vip)).intervalHours, 6)
    assert.equal((await svc.getTierFor(std)).intervalHours, 24)
  })

  test('throws when resolved tier is not declared', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } }, 'enterprise')
    const svc = new BackupRetentionService(makeBackups().service)
    await assert.rejects(() => svc.getTierFor(buildTestTenant()), /tier "enterprise"/)
  })

  test('falls back to built-in default when config has no retention block', async ({ assert }) => {
    setupTestConfig() // no retention key in backup
    const svc = new BackupRetentionService(makeBackups().service)
    const tier = await svc.getTierFor(buildTestTenant())
    assert.equal(tier.intervalHours, 24)
    assert.equal(tier.keepLast, 7)
  })
})

test.group('BackupRetentionService — shouldBackup', () => {
  test('returns true when the tenant has no backups yet', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } })
    const tenant = buildTestTenant()
    const { service } = makeBackups()
    const svc = new BackupRetentionService(service)
    assert.isTrue(await svc.shouldBackup(tenant))
  })

  test('returns false when the latest backup is younger than intervalHours', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } })
    const tenant = buildTestTenant()
    const { service } = makeBackups({
      [tenant.id]: [meta(tenant.id, 'a.dump', 2)],
    })
    const svc = new BackupRetentionService(service)
    assert.isFalse(await svc.shouldBackup(tenant))
  })

  test('returns true when the latest backup is older than intervalHours', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } })
    const tenant = buildTestTenant()
    const { service } = makeBackups({
      [tenant.id]: [meta(tenant.id, 'a.dump', 30)],
    })
    const svc = new BackupRetentionService(service)
    assert.isTrue(await svc.shouldBackup(tenant))
  })

  test('uses the freshest backup when multiple exist', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 7 } })
    const tenant = buildTestTenant()
    const { service } = makeBackups({
      [tenant.id]: [
        meta(tenant.id, 'old.dump', 100),
        meta(tenant.id, 'fresh.dump', 1),
      ],
    })
    const svc = new BackupRetentionService(service)
    assert.isFalse(await svc.shouldBackup(tenant))
  })

  test('respects per-tier intervalHours', async ({ assert }) => {
    setupTestConfig({
      backup: {
        ...testConfig.backup,
        retention: {
          defaultTier: 'standard',
          tiers: {
            standard: { intervalHours: 24, keepLast: 7 },
            premium: { intervalHours: 6, keepLast: 30 },
          },
          getTier: () => 'premium',
        },
      },
    })
    const tenant = buildTestTenant()
    const { service } = makeBackups({
      [tenant.id]: [meta(tenant.id, 'recent.dump', 7)],
    })
    const svc = new BackupRetentionService(service)
    assert.isTrue(await svc.shouldBackup(tenant), 'should fire because 7h > premium interval of 6h')
  })
})

test.group('BackupRetentionService — applyRetention', () => {
  test('keeps the N freshest archives and purges the rest', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 3 } })
    const tenant = buildTestTenant()
    const { service, calls } = makeBackups({
      [tenant.id]: [
        meta(tenant.id, 'a.dump', 5),
        meta(tenant.id, 'b.dump', 1),
        meta(tenant.id, 'c.dump', 10),
        meta(tenant.id, 'd.dump', 30),
        meta(tenant.id, 'e.dump', 60),
      ],
    })
    const svc = new BackupRetentionService(service)
    const plan = await svc.applyRetention(tenant)

    assert.lengthOf(plan.kept, 3)
    assert.deepEqual(
      plan.kept.map((m) => m.file),
      ['b.dump', 'a.dump', 'c.dump']
    )
    assert.deepEqual(
      plan.purged.map((m) => m.file).sort(),
      ['d.dump', 'e.dump'].sort()
    )
    assert.deepEqual(
      calls.deleted.map((c) => c.file).sort(),
      ['d.dump', 'e.dump'].sort()
    )
  })

  test('is a no-op when count <= keepLast', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 5 } })
    const tenant = buildTestTenant()
    const { service, calls } = makeBackups({
      [tenant.id]: [meta(tenant.id, 'a.dump', 1), meta(tenant.id, 'b.dump', 5)],
    })
    const svc = new BackupRetentionService(service)
    const plan = await svc.applyRetention(tenant)
    assert.lengthOf(plan.purged, 0)
    assert.lengthOf(calls.deleted, 0)
  })

  test('planRetention is pure — does not delete', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 1 } })
    const tenant = buildTestTenant()
    const { service, calls } = makeBackups({
      [tenant.id]: [meta(tenant.id, 'a.dump', 1), meta(tenant.id, 'b.dump', 5)],
    })
    const svc = new BackupRetentionService(service)
    const plan = await svc.planRetention(tenant)
    assert.lengthOf(plan.purged, 1)
    assert.lengthOf(calls.deleted, 0, 'planRetention must not call deleteBackup')
  })

  test('a deletion failure does not stop subsequent deletions', async ({ assert }) => {
    setupRetention({ standard: { intervalHours: 24, keepLast: 1 } })
    const tenant = buildTestTenant()
    let firstAttempt = true
    const flakyService = {
      async listBackups() {
        return [meta(tenant.id, 'a.dump', 1), meta(tenant.id, 'b.dump', 5), meta(tenant.id, 'c.dump', 10)]
      },
      async deleteBackup() {
        if (firstAttempt) {
          firstAttempt = false
          throw new Error('disk gremlin')
        }
      },
    } as unknown as BackupService
    const svc = new BackupRetentionService(flakyService)
    const plan = await svc.applyRetention(tenant)
    // both b and c are slated for purge — first throws, second succeeds; still report both as planned
    assert.lengthOf(plan.purged, 2)
  })
})
