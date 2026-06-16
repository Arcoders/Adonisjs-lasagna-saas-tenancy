import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import ace from '@adonisjs/core/services/ace'
import { BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'

/**
 * `tenant:billing:replay` flips a `failed` row back to `pending` and
 * re-dispatches the BullMQ job. Critical: it does NOT reset `attempts`,
 * so operators can spot pathological events that keep failing.
 *
 * We stub `ProcessBillingEventJob.dispatch` to capture invocations
 * without actually queuing.
 */
test.group('tenant:billing:replay (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let dispatched: string[] = []
  let originalDispatch: typeof ProcessBillingEventJob.dispatch

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
    dispatched = []
    originalDispatch = ProcessBillingEventJob.dispatch
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: (p: { eventId: string }) => Promise<void>
      }
    ).dispatch = async ({ eventId }) => {
      dispatched.push(eventId)
    }
  })

  group.each.teardown(async () => {
    await clearBillingTables()
    setConfig(originalConfig)
    ;(
      ProcessBillingEventJob as unknown as {
        dispatch: typeof originalDispatch
      }
    ).dispatch = originalDispatch
  })

  async function seedFailed(eventId: string, attempts = 5): Promise<void> {
    const row = new BillingProcessedEvent()
    row.eventId = eventId
    row.eventType = 'customer.subscription.created'
    row.status = 'failed'
    row.attempts = attempts
    row.lastError = 'previous error message'
    row.processedAt = DateTime.utc().minus({ minutes: 30 })
    row.completedAt = null
    row.tenantId = null
    row.payload = null
    await row.save()
  }

  test('--event-id replays exactly one event', async ({ assert }) => {
    await seedFailed('evt_replay_1')
    await seedFailed('evt_replay_2')

    const cmd = await ace.exec('tenant:billing:replay', ['--event-id=evt_replay_1'])
    assert.equal(cmd.exitCode, 0)

    assert.deepEqual(dispatched, ['evt_replay_1'])

    const replayed = await BillingProcessedEvent.find('evt_replay_1')
    assert.equal(replayed?.status, 'pending', 'status reset to pending')
    assert.isNull(replayed?.lastError, 'last_error cleared')
    assert.equal(replayed?.attempts, 5, 'attempts NOT reset (operator visibility)')

    const untouched = await BillingProcessedEvent.find('evt_replay_2')
    assert.equal(untouched?.status, 'failed', 'other failed row untouched')
  })

  test('--all-failed replays every failed row', async ({ assert }) => {
    await seedFailed('evt_a')
    await seedFailed('evt_b')
    await seedFailed('evt_c')

    // Mix in a non-failed row to confirm it's NOT replayed.
    const completed = new BillingProcessedEvent()
    completed.eventId = `evt_done_${randomUUID().slice(0, 6)}`
    completed.eventType = 'customer.subscription.created'
    completed.status = 'completed'
    completed.attempts = 1
    completed.processedAt = DateTime.utc().minus({ minutes: 5 })
    completed.completedAt = DateTime.utc().minus({ minutes: 5 })
    completed.payload = null
    await completed.save()

    const cmd = await ace.exec('tenant:billing:replay', ['--all-failed'])
    assert.equal(cmd.exitCode, 0)
    assert.lengthOf(dispatched, 3)
    assert.includeMembers(dispatched, ['evt_a', 'evt_b', 'evt_c'])
    assert.notInclude(dispatched, completed.eventId)
  })

  test('exits 1 when neither flag is passed', async ({ assert }) => {
    const cmd = await ace.exec('tenant:billing:replay', [])
    assert.equal(cmd.exitCode, 1)
    assert.lengthOf(dispatched, 0)
  })

  test('--event-id with unknown id reports nothing to replay (exit 0)', async ({ assert }) => {
    const cmd = await ace.exec('tenant:billing:replay', ['--event-id=evt_does_not_exist'])
    assert.equal(cmd.exitCode, 0)
    assert.lengthOf(dispatched, 0)
  })

  test('--all-failed on empty ledger reports nothing (exit 0)', async ({ assert }) => {
    const cmd = await ace.exec('tenant:billing:replay', ['--all-failed'])
    assert.equal(cmd.exitCode, 0)
    assert.lengthOf(dispatched, 0)
  })
})
