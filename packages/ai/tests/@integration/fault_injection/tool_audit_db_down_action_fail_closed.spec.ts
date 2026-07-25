import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../src/services/tool_executor.js'
import AIException from '../../../src/exceptions/ai_exception.js'
import MockAIProvider from '../../../src/testing/mock_ai_provider.js'
import { buildToolLoopProducer } from '../../../src/gateway/tool_loop.js'
import {
  deriveAiToolConfirmationMacKey,
  hashToolArgs,
  mintToolConfirmation,
} from '../../../src/gateway/tool_confirmation.js'
import type AiActionLedger from '../../../src/services/action_ledger.js'
import type { AiToolAuditSink } from '../../../src/gateway/audit_seam.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../src/define_config.js'
import type {
  AIStreamRequest,
  AIToolDefinition,
  StreamFragment,
} from '../../../src/types/ai_provider_contract.js'

/**
 * Fault-injection tier: the AUDIT DB is down when a confirmed action tries to run.
 *
 * An action inverts the read-tool audit ordering: its intent is
 * written FAIL-CLOSED, BEFORE the effect. A mutation that ran with no durable record of
 * intent is one nobody can account for, so if the intent write cannot land the action
 * must NOT happen. The unit specs prove that ordering with fakes; this proves it against
 * the REAL loop + executor over real Postgres, with a REAL side effect (an INSERT) that
 * must be ABSENT afterwards.
 *
 * The fault lands only at the audit sink, and only faithfully: the real `PgToolAuditSink`
 * does not catch the writer's throw, and the real `AiAuditWriter.append` throws
 * `AIException('audit_write_failed')` (503) on any write failure, so the stand-in sink
 * throws exactly that. The at-most-once fence is claimed FIRST (the ledger claim
 * succeeds), then the intent append fails, so the effect is proven never to have run and
 * the claimed-but-unsettled row is the honest "unknown" tombstone the design intends.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const TENANT = { id: randomUUID() } as unknown as TenantModelContract
const SCHEMA = `ai_audit_fault_${suffix}`
const CONN = `ai_audit_fault_conn_${suffix}`
const PRINCIPAL_HASH = 'principal-hash-under-test'
const MAC_KEY = deriveAiToolConfirmationMacKey(`audit-fault-app-key-${suffix}00`)

let ready = false

/** Whether the audit backend is currently unreachable. */
let auditDown = false

/** How many times the intent write was attempted; pins the fault to what this spec injected. */
let auditAttempts = 0

/** The ambient tenancy scope, the shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()

/**
 * The action's REAL side effect: an INSERT the test then proves is absent. It resolves
 * its connection from the ambient scope, exactly as a `TenantBaseModel` write would.
 */
const cancelBooking: AIToolHostDefinition = {
  name: 'cancel_booking',
  description: 'cancel a booking (writes a row)',
  inputSchema: { type: 'object', properties: {} },
  mode: 'action',
  summarizeArgs: () => 'cancel the booking',
  handler: async () => {
    const active = als.getStore()
    if (!active) throw new Error('the handler ran with no ambient tenancy scope')
    await db
      .connection(CONN)
      .rawQuery(`INSERT INTO "${SCHEMA}".effects (marker) VALUES (?)`, ['ran'])
    return { cancelled: true }
  },
}

/**
 * A stand-in for the backoffice tool-audit sink. When the backend is down it throws the
 * SAME typed failure the real `PgToolAuditSink` → `AiAuditWriter` chain throws, so the
 * executor's fail-closed intent path sees production's shape.
 */
const auditSink: AiToolAuditSink = {
  append: async () => {
    auditAttempts += 1
    if (auditDown) {
      throw new AIException('audit_write_failed', 'Refusing: the audit row could not be written')
    }
  },
}

/** A healthy in-memory fence: the claim lands (at-most-once), the AUDIT is what fails. */
function fakeLedger(): { ledger: AiActionLedger; claims: string[] } {
  const claims: string[] = []
  const ledger = {
    claim: async (_tenantId: string, effectKey: string) => {
      claims.push(effectKey)
      return { kind: 'claimed' as const }
    },
    settle: async () => {},
    fail: async () => {},
  }
  return { ledger: ledger as unknown as AiActionLedger, claims }
}

const toolsConfig: AIToolsConfig = {
  registry: [cancelBooking],
  authorizeTool: () => ({ kind: 'allow' }),
  actionTools: { enabled: true },
}
const ctx = {} as unknown as HttpContext
const baseRequest: AIStreamRequest = {
  messages: [{ role: 'user', content: 'cancel my booking' }],
}
const WIRE_TOOLS: AIToolDefinition[] = [
  { name: 'cancel_booking', description: 'cancel a booking', inputSchema: {} },
]

/** A confirmation token for THIS action, so the executor plans it to run rather than challenge. */
function tokenForCancel(): string {
  const binding = {
    tenantId: TENANT.id,
    principalHash: PRINCIPAL_HASH,
    toolName: 'cancel_booking',
    argsHash: hashToolArgs({}),
  }
  return mintToolConfirmation(MAC_KEY, binding).token
}

function toolCallFragment(id: string): StreamFragment {
  return {
    data: '',
    tokens: 0,
    event: 'tool_call',
    toolCall: { id, name: 'cancel_booking', arguments: '{}' },
  }
}

/** Drive the REAL loop for one confirmed action call, capturing any fatal error. */
async function runConfirmedAction(ledger: AiActionLedger): Promise<{ error: unknown }> {
  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    rounds: [[toolCallFragment('call-1')], [{ data: 'done', tokens: 1 }]],
  })
  const executor = new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
    toolAudit: auditSink,
    confirmationMacKey: MAC_KEY,
    actionLedger: ledger,
  })
  const producer = buildToolLoopProducer({
    tenantId: TENANT.id,
    provider,
    baseRequest,
    tools: WIRE_TOOLS,
    executor: executor.forRequest(ctx, TENANT, [cancelBooking], PRINCIPAL_HASH, [tokenForCancel()]),
    perRoundMaxTokens: 100,
  })
  let error: unknown
  try {
    for await (const _fragment of producer(new AbortController().signal)) {
      /* drain the stream */
    }
  } catch (caught) {
    error = caught
  }
  return { error }
}

async function effectRowCount(): Promise<number> {
  const result = await db
    .connection(CONN)
    .rawQuery(`SELECT count(*)::int AS n FROM "${SCHEMA}".effects`)
  return (result.rows as { n: number }[])[0]?.n ?? -1
}

test.group('AI action audit DB down: fail-closed before the effect on real Postgres', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await client.rawQuery('SELECT 1')
    } catch {
      ready = false
      return async () => {}
    }
    ready = true

    const template = db.manager.get(primary)?.config
    db.manager.add(CONN, { ...template, searchPath: [SCHEMA] } as never)
    await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`)
    await db
      .connection(CONN)
      .rawQuery(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".effects (marker text)`)

    return async () => {
      await client.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
      if (db.manager.has(CONN)) await db.manager.release(CONN)
    }
  })

  group.each.setup(async () => {
    auditDown = false
    auditAttempts = 0
    if (ready) await db.connection(CONN).rawQuery(`TRUNCATE "${SCHEMA}".effects`)
  })

  test('with the audit DB down, a confirmed action is refused and its effect never runs', async ({
    assert,
  }) => {
    auditDown = true
    const { ledger, claims } = fakeLedger()
    const { error } = await runConfirmedAction(ledger)

    // Fail-closed: the intent could not be written, so the action is refused and the
    // loop aborts in-band with the writer's own typed failure, not a raw error.
    assert.instanceOf(error, AIException)
    assert.equal((error as AIException).aiCode, 'audit_write_failed')
    assert.isAbove(auditAttempts, 0, 'the intent write must have been attempted')

    // The whole point: the effect NEVER ran. The target table is empty.
    assert.equal(await effectRowCount(), 0, 'the action must not have written its row')

    // The fence WAS claimed first, so the effect key is spent: a blind retry of the
    // same token replays rather than firing twice, and the claimed-but-unsettled row is
    // the honest "unknown" tombstone. At-most-once holds through the audit outage.
    assert.lengthOf(claims, 1, 'the confirmation was claimed before the intent write failed')
  }).skip(() => !ready, 'Postgres unavailable')

  test('with the audit DB healthy, the same confirmed action runs and writes exactly once', async ({
    assert,
  }) => {
    auditDown = false
    const { ledger } = fakeLedger()
    const { error } = await runConfirmedAction(ledger)

    assert.isUndefined(error, 'a healthy audit path must not abort a confirmed action')
    assert.equal(await effectRowCount(), 1, 'the confirmed action writes its row exactly once')
  }).skip(() => !ready, 'Postgres unavailable')
})
