import { qualifyBackofficeTable } from '@adonisjs-lasagna/saas-tenancy/sdk'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import { AI_ACTION_LEDGER_TABLE, TOOL_ACTION_LEDGER_TTL_MS } from '../constants.js'

/**
 * The at-most-once fence for confirmed action tools.
 *
 * The gap it closes is narrow and real: the response cache is side-effect-free on
 * replay, but a stream that dies AFTER the effect fired and BEFORE it completed is
 * never cached. Without a record, the client retries, the model re-proposes, the
 * human confirms again and the mutation happens twice. That hole exists no matter
 * how the confirmation itself is designed, which is why this is a separate
 * mechanism from the token: a bearer token cannot be burned, so statelessness is
 * not replay-safety. The token is the capability; this is the fence.
 *
 * `effect_key` is UNIQUE and the claim is a single `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING`, so the set-if-absent is atomic in one statement: two
 * concurrent claims on one token cannot both win, with no lock and no
 * read-then-write race. The key is the confirmation token's own MAC, and every
 * mint carries a fresh nonce, so a conflict can only mean this exact token already
 * fired. Keyed by the arguments instead, a deliberate repeat of the same action
 * would be indistinguishable from a replay and would silently vanish.
 *
 * FAIL-CLOSED, deliberately: a claim that cannot be made throws, so the effect does
 * not happen. A mutation that cannot be made at-most-once must not be made at all.
 * The cost is honest and belongs in the docs: when the backoffice database is
 * unreachable, action tools are unavailable. Read tools are untouched.
 *
 * Expiry is enforced in the query because Postgres has no TTL, and the sweep is
 * pure garbage collection with no bearing on correctness: an expired row's effect
 * key can never recur, since it is a MAC over a nonce that is never reused.
 *
 * Stateful only through the injected db, so it is a container singleton resolved
 * via `container.make`, never `new`-ed per request.
 */

/** The minimal Lucid surface this needs, injected so it never value-imports the eager core barrel. */
export interface ActionLedgerQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
}

export interface ActionLedgerDb {
  connection(name: string): ActionLedgerQueryClient
}

export interface AiActionLedgerDeps {
  /** Resolve the Lucid db manager, for the backoffice connection + raw queries. */
  getDb: () => Promise<ActionLedgerDb>
  /** The backoffice connection name (the shared control schema lives there). */
  connectionName: string
  /**
   * The backoffice SCHEMA name (`config.backofficeSchemaName`), qualified through
   * {@link qualifyBackofficeTable} rather than a hardcoded `backoffice.` literal.
   * A host that renamed the schema must not have every action tool fail closed.
   */
  schemaName: string
  /**
   * The active tenancy scope id (the satellite ContextSeal). Raw queries bypass the
   * kernel ContextSeal, so this re-asserts that the row's tenant is the bound one,
   * exactly as `AiAuditWriter.append` does. Undefined (no scope bound) trusts the
   * caller, the same posture as the mirrored seams.
   */
  activeScopeTenantId: () => string | undefined
  /** Record lifetime. Default {@link TOOL_ACTION_LEDGER_TTL_MS}. */
  ttlMs?: number | undefined
}

/**
 * The outcome of trying to fence one effect.
 *
 * `claimed` means this caller owns the effect and must run it. `replay` means this
 * token already fired and the caller must NOT run it again: `state` says what
 * happened, and `result` carries the recorded outcome to hand back instead.
 *
 * A `replay` whose state is still `claimed` is the ugly case and it is reported
 * honestly rather than smoothed over: the process died mid-effect, so whether the
 * mutation landed is UNKNOWN. Re-running it could double it and reporting success
 * could invent one. The caller surfaces it and the human decides.
 */
export type ActionClaim =
  | { readonly kind: 'claimed' }
  | {
      readonly kind: 'replay'
      readonly state: 'claimed' | 'settled' | 'failed'
      readonly result: string | null
    }

export default class AiActionLedger {
  /** The `"schema"."ai_action_ledger"` reference, derived once from the configured schema. */
  readonly #table: string
  readonly #ttlMs: number

  constructor(private readonly deps: AiActionLedgerDeps) {
    this.#table = qualifyBackofficeTable(deps.schemaName, AI_ACTION_LEDGER_TABLE)
    this.#ttlMs = deps.ttlMs ?? TOOL_ACTION_LEDGER_TTL_MS
  }

  /**
   * Fence one effect. Returns `claimed` exactly once per effect key; every later
   * call for that key returns `replay`.
   *
   * The whole thing is one statement on purpose. A SELECT-then-INSERT would have a
   * window where two requests both read "absent" and both insert, and the one that
   * lost would surface as a duplicate-key error AFTER its handler had already run.
   * `ON CONFLICT DO NOTHING RETURNING id` collapses that: the winner gets a row
   * back, the loser gets nothing, and neither has touched the effect yet.
   *
   * An expired row is dead but still occupies its key, so the claim takes it over
   * rather than conflicting with it. That can only ever be a no-op in practice
   * (effect keys are MACs over a nonce and never recur), but leaving it out would
   * mean a stale row could block a key forever, and a fence that can wedge is worse
   * than one that cleans up after itself.
   */
  async claim(tenantId: string, effectKey: string, toolName: string): Promise<ActionClaim> {
    this.#assertScope(tenantId)
    const client = await this.#client()
    const expiresAt = new Date(Date.now() + this.#ttlMs)

    try {
      // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); every value is a ? bind.
      const inserted = await client.rawQuery(
        `INSERT INTO ${this.#table} (tenant_id, effect_key, state, tool_name, expires_at)
         VALUES (?, ?, 'claimed', ?, ?)
         ON CONFLICT (effect_key) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id,
               state = 'claimed',
               tool_name = EXCLUDED.tool_name,
               result = NULL,
               settled_at = NULL,
               created_at = now(),
               expires_at = EXCLUDED.expires_at
           WHERE ${this.#table}.expires_at <= now()
         RETURNING id`,
        [tenantId, effectKey, toolName, expiresAt]
      )
      if (rowCount(inserted) > 0) return { kind: 'claimed' }
    } catch (error) {
      this.#failClosed(tenantId, 'claim', error)
    }

    // No row back: a live record already owns this key, so this is a replay. The
    // read is a separate statement, but it cannot race into a wrong answer: the
    // only writer for a key is whoever claimed it, and the key never recurs.
    const existing = await this.#lookup(tenantId, effectKey)
    if (!existing) {
      // The row vanished between the conflict and the read: only a concurrent purge
      // or a sweep can do that. Refusing is the safe direction, since the effect may
      // already have fired and we no longer have its record to prove otherwise.
      this.#failClosed(tenantId, 'lookup_missing')
    }
    return { kind: 'replay', state: existing.state, result: existing.result }
  }

  /**
   * Record that a claimed effect completed, with the bounded result a replay
   * returns instead of re-executing.
   *
   * Fail-closed like the claim: an effect that fired but could not be recorded as
   * settled leaves a row at `claimed`, which reads as "unknown", not as "safe to
   * retry". That is the honest state, and it is why there is no auto-retry.
   */
  async settle(tenantId: string, effectKey: string, result: string | null): Promise<void> {
    this.#assertScope(tenantId)
    const client = await this.#client()
    try {
      // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); every value is a ? bind.
      await client.rawQuery(
        `UPDATE ${this.#table}
            SET state = 'settled', result = ?, settled_at = now()
          WHERE effect_key = ? AND tenant_id = ?`,
        [result, effectKey, tenantId]
      )
    } catch (error) {
      this.#failClosed(tenantId, 'settle', error)
    }
  }

  /**
   * Record that a claimed effect failed. The row stays, so the same token cannot be
   * re-presented to retry a mutation whose state we do not know: a handler that
   * threw may still have written. A fresh request mints a fresh token.
   */
  async fail(tenantId: string, effectKey: string, reason: string): Promise<void> {
    this.#assertScope(tenantId)
    const client = await this.#client()
    try {
      // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); every value is a ? bind.
      await client.rawQuery(
        `UPDATE ${this.#table}
            SET state = 'failed', result = ?, settled_at = now()
          WHERE effect_key = ? AND tenant_id = ?`,
        [reason.slice(0, 200), effectKey, tenantId]
      )
    } catch {
      // Best-effort, and the ONE place here that is: the effect already ran and the
      // row already says 'claimed', which is the conservative reading. Throwing now
      // would replace an honest "unknown" with a failure the caller cannot act on.
    }
  }

  /**
   * Drop every record for one tenant (the purge seam). Fail-closed like the
   * idempotency epoch bump: a purge that silently did nothing would be a compliance
   * bug, so the caller must see the failure.
   *
   * These rows hold no PII: no principal, no arguments, and the key is a MAC. The
   * audit row is what records that an action happened; this only records that one
   * token was spent.
   */
  async purgeTenant(tenantId: string): Promise<number> {
    const client = await this.#client()
    // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); the tenant filter is a ? bind.
    const deleted = await client.rawQuery(`DELETE FROM ${this.#table} WHERE tenant_id = ?`, [
      tenantId,
    ])
    return rowCount(deleted)
  }

  /**
   * Reclaim expired rows. Pure garbage collection: an expired record can never be
   * consulted again, because its effect key is a MAC over a nonce that is never
   * reused. Safe to run from a schedule, or never.
   */
  async sweepExpired(): Promise<number> {
    const client = await this.#client()
    // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); no user input is interpolated.
    const deleted = await client.rawQuery(`DELETE FROM ${this.#table} WHERE expires_at <= now()`)
    return rowCount(deleted)
  }

  async #lookup(
    tenantId: string,
    effectKey: string
  ): Promise<{ state: 'claimed' | 'settled' | 'failed'; result: string | null } | null> {
    const client = await this.#client()
    try {
      // safe-sql: #table is qualified via qualifyBackofficeTable (validates the schema); every value is a ? bind.
      const found = await client.rawQuery(
        `SELECT state, result FROM ${this.#table}
          WHERE effect_key = ? AND tenant_id = ? AND expires_at > now()
          LIMIT 1`,
        [effectKey, tenantId]
      )
      const row = rows(found)[0] as { state?: unknown; result?: unknown } | undefined
      if (!row || typeof row.state !== 'string') return null
      if (row.state !== 'claimed' && row.state !== 'settled' && row.state !== 'failed') return null
      return { state: row.state, result: typeof row.result === 'string' ? row.result : null }
    } catch (error) {
      this.#failClosed(tenantId, 'lookup', error)
    }
  }

  async #client(): Promise<ActionLedgerQueryClient> {
    const db = await this.deps.getDb()
    return db.connection(this.deps.connectionName)
  }

  /**
   * The satellite ContextSeal re-assert, mirroring `AiAuditWriter.append`: a raw
   * query bypasses the kernel seal, so a request already bound to another tenant's
   * scope must not be able to fence (or read) this tenant's effect.
   */
  #assertScope(tenantId: string): void {
    const active = this.deps.activeScopeTenantId()
    if (active !== undefined && active !== tenantId) {
      emitAiGuardEvent('guard.ai_scope_mismatch', {
        tenantId,
        metadata: { op: 'action_ledger' },
      })
      throw new AIException(
        'tenant_scope_mismatch',
        'Refusing the action ledger write: the row tenant does not match the active tenancy scope.'
      )
    }
  }

  /** Every ledger failure lands here: emit, then throw a retryable 503. Typed `never` so callers narrow. */
  #failClosed(tenantId: string, stage: string, cause?: unknown): never {
    emitAiGuardEvent('guard.ai_action_ledger_unavailable', {
      tenantId,
      metadata: { stage },
    })
    throw new AIException(
      'tool_action_unavailable',
      'Refusing the action: its at-most-once record could not be written, so the effect ' +
        'cannot be guaranteed to happen only once. Retry once the store recovers.',
      cause !== undefined ? { cause } : undefined
    )
  }
}

/** Lucid's pg driver returns `{ rows, rowCount }`; narrowed here so the service never imports it. */
function rows(result: unknown): unknown[] {
  const out = (result as { rows?: unknown })?.rows
  return Array.isArray(out) ? out : []
}

function rowCount(result: unknown): number {
  const count = (result as { rowCount?: unknown })?.rowCount
  if (typeof count === 'number') return count
  return rows(result).length
}
