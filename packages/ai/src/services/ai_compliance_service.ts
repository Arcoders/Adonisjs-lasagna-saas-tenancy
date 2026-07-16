import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import { hashAuditPrincipal } from '../gateway/audit_seam.js'
import type ConversationMemoryService from './conversation_memory_service.js'
import type VectorStoreService from './vector_store_service.js'
import type AiIdempotencyService from '../gateway/idempotency.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The WS-AI-9 compliance orchestrator: composes the existing purge seams into
 * GDPR-grade erasure of a tenant's or a principal's AI data.
 *
 * Design (locked across three reviews):
 *  - `bumpEpoch` runs FIRST (the cache gate: it neutralizes the most-live PII,
 *    the raw response frames, and is verifiably fail-closed). Then memory, then
 *    embeddings. Every step is best-effort-CONTINUE with an HONEST per-step
 *    summary (`ok` | `failed` | `skipped`), so a failure in one store never
 *    silently skips the others and never falsely claims success (E22). All
 *    deletes are idempotent, so a non-zero exit + retry converges.
 *  - Vector work runs inside `tenancy.run(tenant)` so the raw-SQL ContextSeal
 *    ACTIVELY protects against a wrong tenant (E16); a per-tenant Redis lock
 *    stops two concurrent purges double-firing the audit + counters (E15).
 *  - The admin action is recorded via the KERNEL audit best-effort (E20/decision
 *    4), never the fail-closed AI chain (which would throw AFTER data is gone).
 *  - The auto-purge path (tenant lifecycle) is NON-throwing but emits
 *    `guard.ai_auto_purge_failed` + a metric, so a silent failed erasure is
 *    impossible (E6).
 *
 * Stateful only through its injected seams (a container singleton), and it never
 * value-imports the eager core barrel: `tenancy.run` and the kernel audit arrive
 * as narrow injected deps.
 */

/** Per-tenant integer metrics (never carrying content). */
export const AI_PURGE_TOTAL_METRIC = 'ai_purge_total'
export const AI_PURGE_FAILURES_METRIC = 'ai_purge_failures'
export const AI_PURGE_KEYS_DELETED_METRIC = 'ai_purge_keys_deleted'
export const AI_DELETE_BY_ACTOR_COUNT_METRIC = 'ai_delete_by_actor_count'
export const AI_AUTO_PURGE_FAILURES_METRIC = 'ai_auto_purge_failures'

/** How long the per-tenant purge dedup lock lives (long enough to cover a big batched erasure). */
const PURGE_LOCK_TTL_MS = 10 * 60 * 1000

export type PurgeScope = 'tenant' | 'user' | 'source'
export type PurgeStepName = 'epoch' | 'memory' | 'embeddings'
export type PurgeStepStatus = 'ok' | 'failed' | 'skipped'

/** One step of a purge, with its outcome: the honest, PII-free unit of the summary. */
export interface PurgeStep {
  readonly step: PurgeStepName
  readonly status: PurgeStepStatus
  /** Rows/keys removed (present on an `ok` delete). */
  readonly count?: number | undefined
  /** A short reason code on `failed`/`skipped` (never content). */
  readonly code?: string
}

export interface PurgeSummary {
  readonly tenantId: string
  readonly scope: PurgeScope
  readonly steps: readonly PurgeStep[]
  /** True iff no step failed. The command exits non-zero when false. */
  readonly ok: boolean
}

export interface AiCompliancePurgeOptions {
  /** The operator identity for the kernel audit row (E20). */
  readonly actorId?: string | null
  /** Run a FULL audit-chain verify and fold its result into the audit metadata (E10). Default off (a full walk is O(n)). */
  readonly verifyChain?: boolean
}

export interface AiComplianceDeps {
  readonly memory: ConversationMemoryService
  readonly vectorStore: VectorStoreService
  readonly idempotency: AiIdempotencyService
  /** Run `fn` with `tenant` bound as the active tenancy scope (kernel `tenancy.run`), so the vector ContextSeal actively protects (E16). */
  readonly runScoped: <T>(tenant: TenantModelContract, fn: () => Promise<T>) => Promise<T>
  /** Whether embeddings are configured; when false the vector step is skipped (no table to purge). */
  readonly embeddingsEnabled: boolean
  /** Raw Redis accessor (the `'redis'` binding) for the per-tenant purge dedup lock (E15). */
  readonly getRedis: () => Promise<any>
  /** Best-effort kernel audit of the admin action (E20); absent ⇒ no audit row. */
  readonly auditLog?: (options: {
    tenantId: string
    actorType: 'admin'
    actorId: string | null
    action: string
    metadata: Record<string, unknown>
  }) => Promise<unknown>
  /** Full AI-audit-chain verify (AiAuditWriter.verify), used only under `verifyChain` (E10). */
  readonly verifyAuditChain?:
    | ((tenantId: string) => Promise<{ ok: boolean; checked: number }>)
    | undefined
  /** Per-tenant integer metric sink (MetricsService.emitMetric). */
  readonly metric?: (tenantId: string, name: string, value: number) => void
  /** Metadata-only warn log (never content). */
  readonly warn?: (message: string) => void
}

export default class AiComplianceService {
  readonly #deps: AiComplianceDeps

  constructor(deps: AiComplianceDeps) {
    this.#deps = deps
  }

  /** Erase ALL of a tenant's AI data: cache epoch, conversation memory, and every embedding. */
  async purgeTenant(
    tenant: TenantModelContract,
    opts: AiCompliancePurgeOptions = {}
  ): Promise<PurgeSummary> {
    return this.#run(
      tenant,
      'tenant',
      opts,
      { principalHash: null, sourceHash: null },
      async (steps) => {
        await this.#step(steps, 'epoch', () => this.#deps.idempotency.bumpEpoch(tenant.id))
        if (!this.#gateOpen(steps)) return
        await this.#step(steps, 'memory', () => this.#deps.memory.purgeTenant(tenant.id))
        await this.#embeddingsStep(steps, () =>
          this.#deps.runScoped(tenant, () => this.#deps.vectorStore.purgeTenant(tenant))
        )
      }
    )
  }

  /**
   * Per-user right-to-erasure. Memory keys off the RAW principal; embeddings key
   * off its SHA-256 `actor` hash. The two stores deliberately key off different
   * forms, so one value must NOT feed both (or one erasure silently no-ops).
   * The caller passes the raw principal.
   */
  async purgeUser(
    tenant: TenantModelContract,
    rawPrincipal: string,
    opts: AiCompliancePurgeOptions = {}
  ): Promise<PurgeSummary> {
    const actorHash = hashAuditPrincipal(rawPrincipal)
    return this.#run(
      tenant,
      'user',
      opts,
      { principalHash: actorHash, sourceHash: null },
      async (steps) => {
        await this.#step(steps, 'epoch', () => this.#deps.idempotency.bumpEpoch(tenant.id))
        if (!this.#gateOpen(steps)) return
        await this.#step(steps, 'memory', () =>
          this.#deps.memory.purgeUser(tenant.id, rawPrincipal)
        )
        if (actorHash === null) {
          steps.push({ step: 'embeddings', status: 'skipped', code: 'no_principal' })
          return
        }
        await this.#embeddingsStep(steps, () =>
          this.#deps.runScoped(tenant, () =>
            this.#deps.vectorStore.deleteByActor(tenant, actorHash)
          )
        )
      }
    )
  }

  /** Erase one document's embeddings (per-source erasure); bumps the cache epoch too, since a cached answer may quote it. */
  async purgeSource(
    tenant: TenantModelContract,
    source: string,
    opts: AiCompliancePurgeOptions = {}
  ): Promise<PurgeSummary> {
    const sourceHash = hashAuditPrincipal(source)
    return this.#run(tenant, 'source', opts, { principalHash: null, sourceHash }, async (steps) => {
      await this.#step(steps, 'epoch', () => this.#deps.idempotency.bumpEpoch(tenant.id))
      if (!this.#gateOpen(steps)) return
      await this.#embeddingsStep(steps, () =>
        this.#deps.runScoped(tenant, () => this.#deps.vectorStore.deleteBySource(tenant, source))
      )
    })
  }

  /**
   * The tenant-lifecycle auto-purge (E6/E19). Redis-resident data ONLY (cache
   * epoch + memory): on `tenant_deleted` the schema is already dropped (so no
   * vector call), and on `tenant_anonymized` embeddings are kept by design
   * (decision 1). NON-throwing (the core command already committed), but a
   * failure emits `guard.ai_auto_purge_failed` + a metric so it is never silent.
   */
  async autoPurge(
    tenant: TenantModelContract,
    trigger: 'tenant_deleted' | 'tenant_anonymized'
  ): Promise<void> {
    try {
      const steps: PurgeStep[] = []
      await this.#step(steps, 'epoch', () => this.#deps.idempotency.bumpEpoch(tenant.id))
      if (this.#gateOpen(steps)) {
        await this.#step(steps, 'memory', () => this.#deps.memory.purgeTenant(tenant.id))
      }
      const ok = steps.every((s) => s.status !== 'failed')
      this.#metric(tenant.id, AI_PURGE_TOTAL_METRIC, 1)
      await this.#auditPurge(
        tenant,
        'tenant',
        steps,
        ok,
        { actorId: `lifecycle:${trigger}` },
        {
          principalHash: null,
          sourceHash: null,
        }
      )
      if (!ok) this.#autoPurgeFailed(tenant, trigger, steps)
    } catch {
      // A step-runner throw is already caught inside #step; this guards anything
      // unexpected (e.g. a metric throw) so the listener never rejects.
      this.#autoPurgeFailed(tenant, trigger, [])
    }
  }

  // --- internals -----------------------------------------------------------

  async #run(
    tenant: TenantModelContract,
    scope: PurgeScope,
    opts: AiCompliancePurgeOptions,
    hashes: { principalHash: string | null; sourceHash: string | null },
    body: (steps: PurgeStep[]) => Promise<void>
  ): Promise<PurgeSummary> {
    const lock = await this.#acquireLock(tenant.id)
    if (lock === 'held') {
      this.#deps.warn?.('[ai] a purge for this tenant is already running; skipping the duplicate')
      return {
        tenantId: tenant.id,
        scope,
        steps: [{ step: 'epoch', status: 'skipped', code: 'purge_in_progress' }],
        ok: false,
      }
    }
    try {
      const steps: PurgeStep[] = []
      await body(steps)
      return this.#finish(tenant, scope, steps, opts, hashes)
    } finally {
      if (lock === 'acquired') await this.#releaseLock(tenant.id)
    }
  }

  /**
   * The `bumpEpoch` gate (decision 5): the cache-epoch rotation runs FIRST and
   * must succeed before any store is deleted. If it failed, the deletes are not
   * attempted: a clean abort (nothing half-done) that the operator retries, so
   * a purge never starts without first making pre-purge responses unreachable.
   */
  #gateOpen(steps: PurgeStep[]): boolean {
    return !steps.some((s) => s.step === 'epoch' && s.status === 'failed')
  }

  /** Run one delete/epoch step, recording ok/failed/skipped without ever throwing out. */
  async #step(
    steps: PurgeStep[],
    name: PurgeStepName,
    run: () => Promise<number | void>
  ): Promise<void> {
    try {
      const count = await run()
      steps.push({ step: name, status: 'ok', count: typeof count === 'number' ? count : undefined })
    } catch (error) {
      const code = error instanceof AIException ? error.aiCode : undefined
      // Attach a partial deleted count when a mid-scan memory purge threw (E18).
      const partial = (error as { deletedCount?: number } | null)?.deletedCount
      steps.push({
        step: name,
        status: 'failed',
        count: typeof partial === 'number' ? partial : undefined,
        code: code ?? 'error',
      })
    }
  }

  /** The embeddings step: skipped when embeddings are unconfigured, or when a rowscope tenant has none. */
  async #embeddingsStep(steps: PurgeStep[], run: () => Promise<number>): Promise<void> {
    if (!this.#deps.embeddingsEnabled) {
      steps.push({ step: 'embeddings', status: 'skipped', code: 'embeddings_not_configured' })
      return
    }
    try {
      const count = await run()
      steps.push({ step: 'embeddings', status: 'ok', count })
    } catch (error) {
      const code = error instanceof AIException ? error.aiCode : undefined
      // A rowscope tenant physically has no embeddings table (I1), so a refusal
      // there is "nothing to purge", not a failure.
      const status: PurgeStepStatus = code === 'rowscope_unsupported' ? 'skipped' : 'failed'
      steps.push({ step: 'embeddings', status, code: code ?? 'error' })
    }
  }

  async #finish(
    tenant: TenantModelContract,
    scope: PurgeScope,
    steps: PurgeStep[],
    opts: AiCompliancePurgeOptions,
    hashes: { principalHash: string | null; sourceHash: string | null }
  ): Promise<PurgeSummary> {
    const ok = steps.every((s) => s.status !== 'failed')
    this.#metric(tenant.id, AI_PURGE_TOTAL_METRIC, 1)
    if (!ok) this.#metric(tenant.id, AI_PURGE_FAILURES_METRIC, 1)
    const memoryKeys = steps.find((s) => s.step === 'memory')?.count ?? 0
    if (memoryKeys > 0) this.#metric(tenant.id, AI_PURGE_KEYS_DELETED_METRIC, memoryKeys)
    const embDeleted = steps.find((s) => s.step === 'embeddings')?.count ?? 0
    if (scope === 'user' && embDeleted > 0) {
      this.#metric(tenant.id, AI_DELETE_BY_ACTOR_COUNT_METRIC, embDeleted)
    }
    await this.#auditPurge(tenant, scope, steps, ok, opts, hashes)
    return { tenantId: tenant.id, scope, steps, ok }
  }

  /** Best-effort kernel audit of the purge action (E20). A write failure warns + counts, never flips the purge. */
  async #auditPurge(
    tenant: TenantModelContract,
    scope: PurgeScope,
    steps: PurgeStep[],
    ok: boolean,
    opts: AiCompliancePurgeOptions,
    hashes: { principalHash: string | null; sourceHash: string | null }
  ): Promise<void> {
    const auditLog = this.#deps.auditLog
    if (!auditLog) return
    let chain: { ok: boolean; checked: number } | undefined
    if (opts.verifyChain && this.#deps.verifyAuditChain) {
      try {
        chain = await this.#deps.verifyAuditChain(tenant.id)
      } catch {
        // Best-effort: a verify failure must not fail the purge audit.
      }
    }
    const metadata: Record<string, unknown> = {
      scope,
      ok,
      steps: steps.map((s) => ({
        step: s.step,
        status: s.status,
        count: s.count ?? null,
        code: s.code ?? null,
      })),
      principalHash: hashes.principalHash, // already a one-way SHA-256, non-PII
      sourceHash: hashes.sourceHash,
      chainVerified: chain ? chain.ok : null,
      chainChecked: chain ? chain.checked : null,
    }
    try {
      await auditLog({
        tenantId: tenant.id,
        actorType: 'admin',
        actorId: opts.actorId ?? null,
        action: 'ai.purge',
        metadata,
      })
    } catch {
      this.#metric(tenant.id, AI_PURGE_FAILURES_METRIC, 1)
      this.#deps.warn?.('[ai] the ai.purge audit row could not be written (best-effort)')
    }
  }

  #autoPurgeFailed(tenant: TenantModelContract, trigger: string, steps: PurgeStep[]): void {
    const failed = steps
      .filter((s) => s.status === 'failed')
      .map((s) => s.step)
      .join(',')
    emitAiGuardEvent('guard.ai_auto_purge_failed', {
      tenantId: tenant.id,
      metadata: { trigger: trigger.slice(0, 64), failed: failed.slice(0, 64) || 'unknown' },
    })
    this.#metric(tenant.id, AI_AUTO_PURGE_FAILURES_METRIC, 1)
    this.#deps.warn?.(
      `[ai] auto-purge (${trigger}) failed for a tenant; see guard.ai_auto_purge_failed`
    )
  }

  async #acquireLock(tenantId: string): Promise<'acquired' | 'held' | 'unavailable'> {
    try {
      const redis = await this.#deps.getRedis()
      const res = await redis.set(`ai:purge:lock:${tenantId}`, '1', 'NX', 'PX', PURGE_LOCK_TTL_MS)
      return res === 'OK' ? 'acquired' : 'held'
    } catch {
      // Redis down: proceed WITHOUT the lock rather than block a lawful erasure.
      this.#deps.warn?.('[ai] purge dedup lock unavailable; proceeding without it')
      return 'unavailable'
    }
  }

  async #releaseLock(tenantId: string): Promise<void> {
    try {
      const redis = await this.#deps.getRedis()
      await redis.del(`ai:purge:lock:${tenantId}`)
    } catch {
      // Best-effort: a stale lock self-expires at PURGE_LOCK_TTL_MS.
    }
  }

  #metric(tenantId: string, name: string, value: number): void {
    try {
      this.#deps.metric?.(tenantId, name, value)
    } catch {
      // A metric write must never touch the purge path.
    }
  }
}
