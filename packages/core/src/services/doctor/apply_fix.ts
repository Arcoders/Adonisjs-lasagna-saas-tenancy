import { lazyLogger } from '../../utils/lazy_logger.js'
import type { DoctorContext, DiagnosisIssue } from './types.js'
import type { TenantModelContract } from '../../types/contracts.js'
import { auditCliAction } from '../../commands/audit_cli_action.js'
import { healTenant } from '../tenant_healer.js'

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
    issue.meta = {
      ...issue.meta,
      fixed: true,
      provisioned: result.provisioned,
      migrated: result.migrated,
    }
  } catch (error: any) {
    issue.meta = { ...issue.meta, fixed: false, fixError: error?.message ?? String(error) }
  }
}
