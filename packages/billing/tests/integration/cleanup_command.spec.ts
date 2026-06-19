import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import ace from '@adonisjs/core/services/ace'
import { BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { BillingUsageEvent } from '@adonisjs-lasagna/billing'
import { runBillingCleanup } from '../../build/src/jobs/billing_cleanup_job.js'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'

/**
 * The cleanup logic is shared between the queue job and the
 * `tenant:billing:cleanup` ace command via `runBillingCleanup`. Tests
 * exercise both surfaces:
 *   - direct call (deterministic, batch-size assertions)
 *   - command exec (smoke test that the wiring is intact)
 */
test.group('tenant:billing:cleanup (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    setConfig(originalConfig)
  })

  /** Seed N processed events at a specific age + status. */
  async function seedEvents(
    count: number,
    opts: { ageDays: number; status: 'pending' | 'completed' | 'failed' }
  ): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const eventId = `evt_${randomUUID().slice(0, 8)}_${i}`
      const row = new BillingProcessedEvent()
      row.eventId = eventId
      row.eventType = 'customer.subscription.created'
      row.status = opts.status
      row.attempts = opts.status === 'completed' ? 1 : 0
      row.lastError = null
      row.processedAt = DateTime.utc().minus({ days: opts.ageDays })
      row.completedAt =
        opts.status === 'completed' ? DateTime.utc().minus({ days: opts.ageDays }) : null
      row.tenantId = null
      row.payload = null
      await row.save()
      ids.push(eventId)
    }
    return ids
  }

  test('purges completed events older than retention window', async ({ assert }) => {
    // 3 old completed (>90 days), 2 fresh completed (10 days), 1 old failed.
    const oldCompleted = await seedEvents(3, { ageDays: 100, status: 'completed' })
    const freshCompleted = await seedEvents(2, { ageDays: 10, status: 'completed' })
    const oldFailed = await seedEvents(1, { ageDays: 100, status: 'failed' })

    const result = await runBillingCleanup()

    assert.equal(result.deleted, 3, 'only 3 old completed rows purged')

    // Fresh completed survives.
    for (const id of freshCompleted) {
      const row = await BillingProcessedEvent.find(id)
      assert.isNotNull(row, `${id} (10 days old) must NOT be purged`)
    }
    // Old failed survives — purge is for completed only (audit + replay window).
    for (const id of oldFailed) {
      const row = await BillingProcessedEvent.find(id)
      assert.isNotNull(row, `${id} (failed, 100 days old) must NOT be purged`)
    }
    for (const id of oldCompleted) {
      const row = await BillingProcessedEvent.find(id)
      assert.isNull(row, `${id} (completed, 100 days old) MUST be purged`)
    }
  })

  test('honours custom idempotencyTtlDays from config', async ({ assert }) => {
    // Tighten retention to 7 days.
    const cfg = getConfig()
    setConfig({
      ...cfg,
      billing: {
        ...cfg.billing!,
        webhook: { ...cfg.billing!.webhook, idempotencyTtlDays: 7 },
      },
    } as never)

    await seedEvents(2, { ageDays: 10, status: 'completed' })
    await seedEvents(2, { ageDays: 3, status: 'completed' })

    const result = await runBillingCleanup()

    assert.equal(result.deleted, 2, 'only events older than 7 days purged')
    const survivors = await BillingProcessedEvent.query()
    assert.lengthOf(survivors, 2)
  })

  test('idempotent: re-running cleans nothing on a clean ledger', async ({ assert }) => {
    await seedEvents(5, { ageDays: 100, status: 'completed' })

    const first = await runBillingCleanup()
    assert.equal(first.deleted, 5)

    const second = await runBillingCleanup()
    assert.equal(second.deleted, 0, 'second run is a no-op')
  })

  test('respects batchSize when purging large volumes', async ({ assert }) => {
    // Seed 7 old completed; batch size 3 should require 3 sweeps (3+3+1).
    await seedEvents(7, { ageDays: 100, status: 'completed' })

    const result = await runBillingCleanup({ batchSize: 3 })

    assert.equal(result.deleted, 7, 'all rows purged across multiple batches')
    const remaining = await BillingProcessedEvent.query()
    assert.lengthOf(remaining, 0)
  })

  test('ace command exits 0 and runs the same purge', async ({ assert }) => {
    await seedEvents(2, { ageDays: 100, status: 'completed' })

    const cmd = await ace.exec('tenant:billing:cleanup', [])
    assert.equal(cmd.exitCode, 0)

    const remaining = await BillingProcessedEvent.query().where('status', 'completed')
    assert.lengthOf(remaining, 0)
  })

  /** Seed N meter events at a specific age + status. */
  async function seedMeterEvents(
    count: number,
    opts: { ageDays: number; status: 'pending' | 'sent' | 'failed' }
  ): Promise<string[]> {
    const ids: string[] = []
    const tenantId = randomUUID()
    for (let i = 0; i < count; i++) {
      const id = randomUUID()
      const row = new BillingUsageEvent()
      row.id = id
      row.tenantId = tenantId
      row.meterEventName = 'api_calls'
      row.quantity = 1
      row.idempotencyKey = `${tenantId}:api_calls:${randomUUID()}`
      row.status = opts.status
      row.attempts = opts.status === 'sent' ? 1 : 0
      row.lastError = null
      row.reportedAt = opts.status === 'sent' ? DateTime.utc().minus({ days: opts.ageDays }) : null
      await row.save()
      ids.push(id)
    }
    return ids
  }

  test('purges sent meter events older than retention window; preserves failed/pending', async ({
    assert,
  }) => {
    // Sent meter events: 3 old (purged), 2 fresh (kept).
    const oldSent = await seedMeterEvents(3, { ageDays: 100, status: 'sent' })
    const freshSent = await seedMeterEvents(2, { ageDays: 10, status: 'sent' })
    // Failed + pending of any age: never auto-purged (operator concern).
    const oldFailed = await seedMeterEvents(1, { ageDays: 100, status: 'failed' })
    const oldPending = await seedMeterEvents(1, { ageDays: 100, status: 'pending' })

    const result = await runBillingCleanup()
    assert.equal(result.meterDeleted, 3)

    for (const id of oldSent) {
      const row = await BillingUsageEvent.find(id)
      assert.isNull(row, `old sent meter ${id} must be purged`)
    }
    for (const id of freshSent) {
      const row = await BillingUsageEvent.find(id)
      assert.isNotNull(row, `fresh sent meter ${id} must survive`)
    }
    for (const id of [...oldFailed, ...oldPending]) {
      const row = await BillingUsageEvent.find(id)
      assert.isNotNull(row, `non-sent meter ${id} must NOT be auto-purged`)
    }
  })
})
