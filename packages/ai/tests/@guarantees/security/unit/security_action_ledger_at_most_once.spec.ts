import { test } from '@japa/runner'
import AiActionLedger, {
  type ActionLedgerDb,
  type ActionLedgerQueryClient,
} from '../../../../src/services/action_ledger.js'
import AIException from '../../../../src/exceptions/ai_exception.js'

/**
 * The at-most-once fence for confirmed action tools.
 *
 * The double below is not a stub that returns what the test wants: it implements
 * the one Postgres semantic the whole design leans on, `INSERT ... ON CONFLICT
 * (effect_key) DO UPDATE ... WHERE expires_at <= now() RETURNING id`, including
 * the part that decides everything, that a conflict against a LIVE row returns no
 * row at all. Getting that wrong in the double would make these specs agree with a
 * broken ledger, so the interleaved real-Postgres spec in the integration tier is
 * what finally proves it. This tier proves the policy: what the service does with
 * each answer the database can give.
 */

interface Row {
  tenantId: string
  effectKey: string
  state: string
  toolName: string
  result: string | null
  expiresAt: number
}

/** A tiny store that honours the conflict semantics the SQL relies on. */
class FakeLedgerDb implements ActionLedgerDb {
  readonly rows = new Map<string, Row>()
  failOn: 'insert' | 'select' | 'update' | null = null
  /** Every statement this saw, so a spec can prove the claim really is ONE statement. */
  readonly statements: string[] = []

  connection(): ActionLedgerQueryClient {
    return {
      rawQuery: async (sql: string, bindings: readonly unknown[] = []) => {
        this.statements.push(sql.trim().split('\n')[0]!.trim())
        const now = Date.now()

        if (sql.includes('INSERT INTO')) {
          if (this.failOn === 'insert') throw dropped()
          const [tenantId, effectKey, toolName, expiresAt] = bindings as [
            string,
            string,
            string,
            Date,
          ]
          const existing = this.rows.get(effectKey)
          // The load-bearing branch: a LIVE row means the DO UPDATE's WHERE does not
          // match, so no row comes back and the caller learns it did not win.
          if (existing && existing.expiresAt > now) return { rowCount: 0, rows: [] }
          this.rows.set(effectKey, {
            tenantId,
            effectKey,
            state: 'claimed',
            toolName,
            result: null,
            expiresAt: expiresAt.getTime(),
          })
          return { rowCount: 1, rows: [{ id: 'row-1' }] }
        }

        if (sql.includes('SELECT state')) {
          if (this.failOn === 'select') throw dropped()
          const [effectKey, tenantId] = bindings as [string, string]
          const row = this.rows.get(effectKey)
          if (!row || row.tenantId !== tenantId || row.expiresAt <= now) {
            return { rowCount: 0, rows: [] }
          }
          return { rowCount: 1, rows: [{ state: row.state, result: row.result }] }
        }

        if (sql.includes('UPDATE')) {
          if (this.failOn === 'update') throw dropped()
          const [result, effectKey, tenantId] = bindings as [string | null, string, string]
          const row = this.rows.get(effectKey)
          if (row && row.tenantId === tenantId) {
            row.state = sql.includes("'settled'") ? 'settled' : 'failed'
            row.result = result
          }
          return { rowCount: row ? 1 : 0, rows: [] }
        }

        if (sql.includes('DELETE')) {
          const [tenantId] = bindings as [string]
          let n = 0
          for (const [key, row] of this.rows) {
            const expired = sql.includes('expires_at <= now()') && row.expiresAt <= now
            if (row.tenantId === tenantId || expired) {
              this.rows.delete(key)
              n += 1
            }
          }
          return { rowCount: n, rows: [] }
        }
        return { rowCount: 0, rows: [] }
      },
    }
  }
}

function dropped(): Error {
  const err = new Error('read ECONNRESET') as Error & { code?: string }
  err.code = 'ECONNRESET'
  return err
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const KEY = 'a'.repeat(64)

function ledgerWith(db: FakeLedgerDb, activeScope: string | undefined = undefined): AiActionLedger {
  return new AiActionLedger({
    getDb: async () => db,
    connectionName: 'primary',
    schemaName: 'backoffice',
    activeScopeTenantId: () => activeScope,
  })
}

test.group('action ledger: at-most-once', () => {
  test('the first claim wins and every later one is a replay', async ({ assert }) => {
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)

    assert.deepEqual(await ledger.claim(TENANT, KEY, 'cancel_booking'), { kind: 'claimed' })

    // The disconnect-after-effect case: the effect fired, the stream died, the client
    // retried with the same token. It must NOT fire again.
    const second = await ledger.claim(TENANT, KEY, 'cancel_booking')
    assert.equal(second.kind, 'replay')
  })

  test('a settled effect replays its recorded result instead of re-running', async ({ assert }) => {
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)

    await ledger.claim(TENANT, KEY, 'cancel_booking')
    await ledger.settle(TENANT, KEY, '{"cancelled":"BK-1"}')

    const replay = await ledger.claim(TENANT, KEY, 'cancel_booking')
    assert.equal(replay.kind, 'replay')
    assert.equal(replay.kind === 'replay' ? replay.state : null, 'settled')
    assert.equal(replay.kind === 'replay' ? replay.result : null, '{"cancelled":"BK-1"}')
  })

  test('a row still at claimed replays as UNKNOWN, not as safe to retry', async ({ assert }) => {
    // The process died mid-effect. Whether the mutation landed is genuinely unknown,
    // so the ledger says so rather than smoothing it into a failure (which would
    // invite a retry that could double it) or a success (which could invent one).
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)

    await ledger.claim(TENANT, KEY, 'cancel_booking')
    const replay = await ledger.claim(TENANT, KEY, 'cancel_booking')

    assert.equal(replay.kind === 'replay' ? replay.state : null, 'claimed')
    assert.isNull(replay.kind === 'replay' ? replay.result : 'x')
  })

  test('a failed effect stays fenced: the same token cannot retry the mutation', async ({
    assert,
  }) => {
    // A handler that threw may still have written. Re-running under the same
    // confirmation would be the double-fire the fence exists to stop; a fresh
    // request mints a fresh token, which is a new effect and a new human decision.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)

    await ledger.claim(TENANT, KEY, 'cancel_booking')
    await ledger.fail(TENANT, KEY, 'tool_execution_failed')

    const replay = await ledger.claim(TENANT, KEY, 'cancel_booking')
    assert.equal(replay.kind, 'replay', 'a failed effect must not be re-claimable')
    assert.equal(replay.kind === 'replay' ? replay.state : null, 'failed')
  })

  test('the claim is ONE statement, so two callers cannot both win', async ({ assert }) => {
    // A SELECT-then-INSERT would leave a window where both read "absent", both
    // insert, and the loser only discovers it AFTER its handler already ran.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')

    assert.lengthOf(db.statements, 1)
    assert.include(db.statements[0] ?? '', 'INSERT INTO')
  })

  test('concurrent claims on one key: exactly one is claimed', async ({ assert }) => {
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.claim(TENANT, KEY, 'cancel_booking'))
    )
    assert.lengthOf(
      results.filter((r) => r.kind === 'claimed'),
      1,
      'exactly one caller may own an effect'
    )
  })
})

test.group('action ledger: fails closed', () => {
  test('a store outage on the claim refuses the action rather than running it unfenced', async ({
    assert,
  }) => {
    // The direction that matters. A mutation that cannot be made at-most-once must
    // not be made: action tools are DOWN when the ledger is, and that is correct.
    const db = new FakeLedgerDb()
    db.failOn = 'insert'
    const ledger = ledgerWith(db)

    let caught: unknown
    try {
      await ledger.claim(TENANT, KEY, 'cancel_booking')
    } catch (error) {
      caught = error
    }

    assert.instanceOf(caught, AIException)
    assert.equal((caught as AIException).aiCode, 'tool_action_unavailable')
    assert.equal((caught as AIException).httpStatus, 503)
  })

  test('the outage code is retryable, unlike a bad confirmation', async ({ assert }) => {
    // Nothing is wrong with the request, so a client SHOULD retry once the store is
    // back. This is the half of the pair that must not be fatal, and the two codes
    // sit side by side in a Set the compiler does not check.
    const db = new FakeLedgerDb()
    db.failOn = 'insert'
    const ledger = ledgerWith(db)

    let caught: unknown
    try {
      await ledger.claim(TENANT, KEY, 'cancel_booking')
    } catch (error) {
      caught = error
    }
    assert.isTrue((caught as AIException).isRetryable(), 'a ledger outage is transient')
    // Its neighbour must be classified the other way: a forged or expired token
    // never becomes valid, so retrying it only hammers the MAC on a mutation path.
    assert.isFalse(
      new AIException('tool_confirmation_invalid', 'x').isRetryable(),
      'a bad confirmation is permanent'
    )
  })

  test('a record that vanished between the conflict and the read refuses', async ({ assert }) => {
    // Only a concurrent purge can do this. The effect may already have fired and the
    // proof is gone, so refusing is the only honest answer.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')
    db.failOn = 'select'

    let caught: unknown
    try {
      await ledger.claim(TENANT, KEY, 'cancel_booking')
    } catch (error) {
      caught = error
    }
    assert.equal((caught as AIException)?.aiCode, 'tool_action_unavailable')
  })

  test('settle failing leaves the row at claimed, which reads as unknown', async ({ assert }) => {
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')
    db.failOn = 'update'

    let caught: unknown
    try {
      await ledger.settle(TENANT, KEY, '{"ok":true}')
    } catch (error) {
      caught = error
    }
    assert.equal((caught as AIException)?.aiCode, 'tool_action_unavailable')
    assert.equal(db.rows.get(KEY)?.state, 'claimed', 'the effect ran; its state is unknown')
  })

  test('fail() is best-effort: it never replaces an honest unknown with a throw', async ({
    assert,
  }) => {
    // The effect already ran and the row already says claimed, which is the
    // conservative reading. Throwing here would hand the caller a failure it cannot
    // act on, on top of one it already has.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')
    db.failOn = 'update'

    await ledger.fail(TENANT, KEY, 'tool_execution_failed')
    assert.equal(db.rows.get(KEY)?.state, 'claimed')
  })
})

test.group('action ledger: tenant scope', () => {
  test('a request bound to another tenant cannot fence this one effect', async ({ assert }) => {
    // Raw queries bypass the kernel ContextSeal, so the writer re-asserts. Same
    // shape as AiAuditWriter.append; the I7 confused-deputy check the security
    // review already caught once as a tautology elsewhere.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db, OTHER)

    let caught: unknown
    try {
      await ledger.claim(TENANT, KEY, 'cancel_booking')
    } catch (error) {
      caught = error
    }
    assert.instanceOf(caught, AIException)
    assert.equal((caught as AIException).aiCode, 'tenant_scope_mismatch')
    assert.equal(db.rows.size, 0, 'nothing was written under a mismatched scope')
  })

  test('a matching bound scope proceeds, and no bound scope trusts the caller', async ({
    assert,
  }) => {
    const bound = new FakeLedgerDb()
    assert.deepEqual(await ledgerWith(bound, TENANT).claim(TENANT, KEY, 'cancel_booking'), {
      kind: 'claimed',
    })
    // No ambient scope is the normal streaming path (the kernel seal backstops it).
    const unbound = new FakeLedgerDb()
    assert.deepEqual(await ledgerWith(unbound, undefined).claim(TENANT, KEY, 'cancel_booking'), {
      kind: 'claimed',
    })
  })

  test('one tenant cannot read another tenant record through a replay', async ({ assert }) => {
    const db = new FakeLedgerDb()
    await ledgerWith(db).claim(TENANT, KEY, 'cancel_booking')
    await ledgerWith(db).settle(TENANT, KEY, '{"secret":"tenant-a-result"}')

    // The same effect key, asked for by another tenant. The row exists, so the
    // conflict fires and no row comes back, but the lookup is tenant-filtered and
    // finds nothing, so this refuses rather than handing over tenant A's result.
    let caught: unknown
    let returned: unknown
    try {
      returned = await ledgerWith(db).claim(OTHER, KEY, 'cancel_booking')
    } catch (error) {
      caught = error
    }
    assert.equal((caught as AIException)?.aiCode, 'tool_action_unavailable')
    assert.isUndefined(returned, 'a cross-tenant claim must not resolve at all')
    assert.notInclude(
      JSON.stringify(caught instanceof Error ? caught.message : caught),
      'tenant-a-result',
      "the refusal must not carry the other tenant's recorded result"
    )
  })
})

test.group('action ledger: lifetime', () => {
  test('an expired record is taken over rather than wedging its key forever', async ({
    assert,
  }) => {
    // Effect keys are MACs over a nonce and never recur, so this is a no-op in
    // practice. It exists because a fence that can wedge is worse than one that
    // tidies up: without the takeover, a stale row would block its key permanently.
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')
    db.rows.get(KEY)!.expiresAt = Date.now() - 1

    assert.deepEqual(await ledger.claim(TENANT, KEY, 'cancel_booking'), { kind: 'claimed' })
  })

  test('purgeTenant drops that tenant records', async ({ assert }) => {
    const db = new FakeLedgerDb()
    const ledger = ledgerWith(db)
    await ledger.claim(TENANT, KEY, 'cancel_booking')

    assert.equal(await ledger.purgeTenant(TENANT), 1)
    assert.equal(db.rows.size, 0)
  })
})
