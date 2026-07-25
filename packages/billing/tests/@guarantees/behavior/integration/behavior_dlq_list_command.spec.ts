import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ace from '@adonisjs/core/services/ace'
import { BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from '../../../helpers/helpers.js'

/**
 * `tenant:billing:dlq:list` is the read-only read view over dead-lettered
 * (`status='failed'`) webhook events, pairing with `tenant:billing:replay`. It
 * must never mutate the ledger and must surface the failed rows (with `--json`
 * machine-readable). We capture stdout to assert on the emitted JSON.
 */
test.group('tenant:billing:dlq:list (integration)', (group) => {
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

  async function seed(
    eventId: string,
    status: 'failed' | 'completed',
    over: Partial<{ attempts: number; provider: string; eventType: string }> = {}
  ): Promise<void> {
    const row = new BillingProcessedEvent()
    row.provider = 'stripe'
    row.eventId = eventId
    row.provider = over.provider ?? 'stripe'
    row.eventType = over.eventType ?? 'customer.subscription.created'
    row.status = status
    row.attempts = over.attempts ?? 5
    row.lastError = status === 'failed' ? 'boom: products mapping missing' : null
    row.processedAt = DateTime.utc().minus({ minutes: 30 })
    row.completedAt = status === 'completed' ? DateTime.utc().minus({ minutes: 29 }) : null
    row.tenantId = null
    row.payload = null
    await row.save()
  }

  /** Run a command while capturing everything written to stdout. */
  async function execCapturing(args: string[]): Promise<{ exitCode: number; out: string }> {
    const chunks: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const cmd = await ace.exec('tenant:billing:dlq:list', args)
      return { exitCode: cmd.exitCode ?? 0, out: chunks.join('') }
    } finally {
      process.stdout.write = original
    }
  }

  function parseJson(out: string): { count: number; events: Array<Record<string, unknown>> } {
    const start = out.indexOf('{')
    const end = out.lastIndexOf('}')
    return JSON.parse(out.slice(start, end + 1))
  }

  test('--json lists only failed events with their fields, never mutating', async ({ assert }) => {
    await seed('evt_dlq_1', 'failed', {
      attempts: 7,
      provider: 'paddle',
      eventType: 'subscription.upsert',
    })
    await seed('evt_done', 'completed')

    const { exitCode, out } = await execCapturing(['--json'])
    assert.equal(exitCode, 0)

    const parsed = parseJson(out)
    assert.equal(parsed.count, 1, 'only the failed row is reported')
    assert.equal(parsed.events[0]?.event_id, 'evt_dlq_1')
    assert.equal(parsed.events[0]?.provider, 'paddle')
    assert.equal(parsed.events[0]?.event_type, 'subscription.upsert')
    assert.equal(parsed.events[0]?.attempts, 7)
    assert.isAbove(parsed.events[0]?.age_seconds as number, 0)

    // Read-only: the failed row is untouched.
    const row = await BillingProcessedEvent.find('evt_dlq_1')
    assert.equal(row?.status, 'failed')
    assert.equal(row?.attempts, 7)
  })

  test('empty ledger reports count 0 and exits 0', async ({ assert }) => {
    const { exitCode, out } = await execCapturing(['--json'])
    assert.equal(exitCode, 0)
    assert.equal(parseJson(out).count, 0)
  })

  test('--limit caps the number of rows reported', async ({ assert }) => {
    await seed('evt_a', 'failed')
    await seed('evt_b', 'failed')
    await seed('evt_c', 'failed')

    const { exitCode, out } = await execCapturing(['--json', '--limit=2'])
    assert.equal(exitCode, 0)
    assert.equal(parseJson(out).count, 2)
  })
})
