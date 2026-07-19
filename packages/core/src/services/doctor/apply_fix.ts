import { getConfig } from '../../config.js'
import { lazyLogger } from '../../utils/lazy_logger.js'
import type { DoctorContext, DiagnosisIssue } from './types.js'
import type { TenantModelContract } from '../../types/contracts.js'
import type { ResolvedMigrationAlias } from '../../sdk/configure_kit.js'
import { auditCliAction } from '../../commands/audit_cli_action.js'
import { healTenant } from '../tenant_healer.js'
import { reconcileTenantLedger } from './tenant_ledger_reconcile.js'
import type { ExpectedStructure, CentralLike } from './tenant_ledger_reconcile.js'

export interface ApplyFixOptions {
  /** Append-only audit action name for the mutation, e.g. `tenant:doctor:lifecycle_reconcile`. */
  action: string
  /**
   * Allow the fix to target a soft-deleted tenant. Default false: a fix refuses to
   * write to a concurrently-deleted row. Only a fix whose whole purpose is to touch
   * a deleted tenant sets this true.
   */
  allowDeleted?: boolean
  /** Extra structured metadata recorded on the audit row. */
  metadata?: Record<string, unknown>
}

/**
 * The uniform safe-fix envelope every mutating doctor check routes through, so the
 * re-read + guard + audit + outcome-recording can't be forgotten or done three
 * different ways.
 *
 *  - **Re-read fresh:** the diagnosis snapshot (`ctx.tenants`) was read once at the
 *    start of the run; a fix that mutates that stale row races a concurrent
 *    soft-delete/status change. We reload the tenant right before mutating, closing
 *    the TOCTOU window.
 *  - **Guard:** refuse to write to a concurrently soft-deleted tenant (unless
 *    `allowDeleted`), so `--fix` can never resurrect or corrupt a deleted row.
 *  - **Audit:** write an append-only row (best-effort — a missing audit table warns,
 *    never flips the fix to a failure), closing the compliance hole where the old
 *    `--fix` mutations recorded nothing.
 *  - **Record:** stamp `issue.meta.fixed` true/false so the CLI/report shows the
 *    outcome. A fix that throws is caught and recorded as `fixed:false` + `fixError`;
 *    one failed fix degrades one issue, never aborts the run.
 */
export async function applyFix(
  ctx: DoctorContext,
  issue: DiagnosisIssue,
  mutate: (fresh: TenantModelContract) => Promise<void>,
  opts: ApplyFixOptions
): Promise<void> {
  const tenantId = issue.tenantId
  if (!tenantId) {
    issue.meta = { ...issue.meta, fixed: false, fixError: 'issue carries no tenantId' }
    return
  }
  try {
    const fresh = await ctx.repo.findByIdOrFail(tenantId, true)
    if (!opts.allowDeleted && fresh.isDeleted) {
      issue.meta = {
        ...issue.meta,
        fixed: false,
        fixError: 'tenant was concurrently soft-deleted; refusing to fix',
      }
      return
    }
    await mutate(fresh)
    await auditCliAction(lazyLogger, {
      tenantId,
      action: opts.action,
      metadata: opts.metadata,
    })
    issue.meta = { ...issue.meta, fixed: true }
  } catch (error: any) {
    issue.meta = { ...issue.meta, fixed: false, fixError: error?.message ?? String(error) }
  }
}

/**
 * The heal-based fix envelope: repair a tenant's storage by composing
 * {@link healTenant} (which itself does the fresh re-read + TOCTOU guard + its own
 * `tenant:heal` audit + failed→active recovery), then record the outcome on
 * `issue.meta`. Used by the `schema_missing` / `migrations_never_ran` /
 * `tenant_failed` / `migration_behind` fixes. A heal that throws quarantines the
 * tenant to `failed` (inside `healTenant`) and is recorded here as `fixed:false`,
 * never aborting the run.
 */
export async function applyHeal(
  issue: DiagnosisIssue,
  opts: { admin?: string } = {}
): Promise<void> {
  const tenantId = issue.tenantId
  if (!tenantId) {
    issue.meta = { ...issue.meta, fixed: false, fixError: 'issue carries no tenantId' }
    return
  }
  try {
    const result = await healTenant({ id: tenantId } as TenantModelContract, {
      fireHooks: true,
      ...(opts.admin !== undefined ? { admin: opts.admin } : {}),
    })
    if (result.collisions.length > 0) {
      // Heal hit a duplicate-object collision: the object(s) already exist, so the
      // tenant is not broken but the migration could not apply. This is the relocated
      // ledger state — NOT a heal success. Record it as unfixed and point the operator
      // at the safe, zero-DDL reconcile path rather than leaving a misleading "fixed".
      issue.meta = {
        ...issue.meta,
        fixed: false,
        collisions: result.collisions,
        fixError:
          `object already exists (${result.collisions.join(', ')}) — likely a relocated or ` +
          `inlined migration; run \`tenant:doctor --reconcile-ledger\` to reconcile the ledger`,
      }
    } else {
      issue.meta = {
        ...issue.meta,
        fixed: true,
        provisioned: result.provisioned,
        migrated: result.migrated,
      }
    }
  } catch (error: any) {
    issue.meta = { ...issue.meta, fixed: false, fixError: error?.message ?? String(error) }
  }
}

/** Inputs the drift check hands `applyReconcile` for one relocated `(from → to)` pair. */
export interface ApplyReconcileParams {
  from: string
  to: string
  /** The tenant's schema name (registry-derived). */
  schema: string
  /** The canonical source name set, computed once per run. */
  source: Set<string>
  /** The validated fleet alias map, keyed by `to`. */
  aliasMap: Map<string, ResolvedMigrationAlias>
  /** The precomputed structural probe for `to` (fleet-cached), or null on probe failure. */
  expected: ExpectedStructure | null
  admin?: string | undefined
}

/**
 * The reconcile fix envelope: rewrite a tenant's `adonis_schema` row `from → to` with
 * ZERO DDL through {@link reconcileTenantLedger}'s VERIFY-THEN-COMMIT gates, then record
 * the outcome on `issue.meta`. Physical-identity: the fingerprint of every affected
 * table is asserted byte-identical across the (name-only) write. Fail-closed: any gate
 * miss records `fixed:false` with the refusal reason and never mutates the tenant.
 */
export async function applyReconcile(
  ctx: DoctorContext,
  issue: DiagnosisIssue,
  params: ApplyReconcileParams
): Promise<void> {
  const tenantId = issue.tenantId
  if (!tenantId) {
    issue.meta = { ...issue.meta, fixed: false, fixError: 'issue carries no tenantId' }
    return
  }
  try {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const central = db.connection(getConfig().centralConnectionName)
    const outcome = await reconcileTenantLedger(
      {
        tenantId,
        schema: params.schema,
        from: params.from,
        to: params.to,
        source: params.source,
        aliasMap: params.aliasMap,
        expected: params.expected,
        admin: params.admin,
      },
      {
        repo: ctx.repo,
        // The real Lucid client structurally provides rawQuery + transaction() (whose
        // client provides commit/rollback/rawQuery); its overloaded transaction()
        // signature is just not identical to the minimal CentralLike, so cast at the
        // boundary. Unit tests pass an in-memory CentralLike directly.
        central: central as unknown as CentralLike,
        audit: async (entry) =>
          auditCliAction(lazyLogger, {
            tenantId: entry.tenantId,
            action: entry.action,
            adminId: entry.admin,
            metadata: entry.metadata,
          }),
        onWarn: (m) => lazyLogger.warning(m),
      }
    )
    if (outcome.status === 'reconciled') {
      issue.meta = { ...issue.meta, fixed: true, reconciled: true, from: outcome.from, to: outcome.to }
    } else if (outcome.status === 'already_reconciled') {
      issue.meta = {
        ...issue.meta,
        fixed: true,
        alreadyReconciled: true,
        from: outcome.from,
        to: outcome.to,
      }
    } else {
      issue.meta = {
        ...issue.meta,
        fixed: false,
        reconcileRefused: outcome.reason,
        fixError: `reconcile refused: ${outcome.reason}`,
        from: outcome.from,
        to: outcome.to,
      }
    }
  } catch (error: any) {
    issue.meta = { ...issue.meta, fixed: false, fixError: error?.message ?? String(error) }
  }
}
