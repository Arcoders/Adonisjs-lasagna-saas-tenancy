import type { TenantModelContract, TenantRepositoryContract } from '../../types/contracts.js'
import { resolveTenantRepository } from '../resolve_tenant_repository.js'
import type {
  DoctorCheck,
  DoctorContext,
  DoctorRunOptions,
  DoctorRunResult,
  DiagnosisReport,
} from './types.js'

/**
 * Registry and runner for tenant diagnostic checks. Holds a named map of
 * DoctorCheck instances that callers register or unregister, then `run()`
 * fetches every tenant through keyset (cursor) pagination, applies any tenant
 * and check filters, executes each selected check against a shared context, and
 * aggregates the resulting issues into per-check reports plus severity totals
 * (info, warn, error, fixable). A check that throws is captured as a per-report
 * error rather than failing the whole run, and `fix` opts into attempted repairs.
 *
 * @see DoctorCheck
 * @see DoctorRunResult
 */
export default class DoctorService {
  readonly #checks = new Map<string, DoctorCheck>()

  register(check: DoctorCheck): this {
    this.#checks.set(check.name, check)
    return this
  }

  unregister(name: string): this {
    this.#checks.delete(name)
    return this
  }

  has(name: string): boolean {
    return this.#checks.has(name)
  }

  list(): DoctorCheck[] {
    return [...this.#checks.values()]
  }

  async run(
    options: DoctorRunOptions = {},
    repoOverride?: TenantRepositoryContract
  ): Promise<DoctorRunResult> {
    const repo = repoOverride ?? (await resolveTenantRepository())

    // Cursor-paginated (keyset) fetch instead of one unbounded `SELECT *`, so a
    // large tenant base does not spike memory or hold a giant result set open on
    // every doctor run. The checks still receive the full filtered list.
    const selectedTenantIds =
      options.tenants && options.tenants.length > 0 ? new Set(options.tenants) : null
    const tenants: TenantModelContract[] = []
    await repo.each(
      (t) => {
        if (!selectedTenantIds || selectedTenantIds.has(t.id)) tenants.push(t)
      },
      { includeDeleted: true }
    )

    const selectedNames =
      options.checks && options.checks.length > 0 ? new Set(options.checks) : null

    const checks = [...this.#checks.values()].filter(
      (c) => !selectedNames || selectedNames.has(c.name)
    )

    const ctx: DoctorContext = {
      tenants,
      repo,
      attemptFix: options.fix === true,
    }

    const reports: DiagnosisReport[] = []
    const totals = { info: 0, warn: 0, error: 0, fixable: 0 }

    for (const check of checks) {
      const start = Date.now()
      const report: DiagnosisReport = {
        check: check.name,
        description: check.description,
        durationMs: 0,
        issues: [],
      }

      try {
        const issues = await check.run(ctx)
        report.issues = issues
        for (const issue of issues) {
          totals[issue.severity]++
          if (issue.fixable) totals.fixable++
        }
      } catch (error: any) {
        report.error = error?.message ?? 'check threw'
      } finally {
        report.durationMs = Date.now() - start
        reports.push(report)
      }
    }

    return { reports, totals }
  }
}
