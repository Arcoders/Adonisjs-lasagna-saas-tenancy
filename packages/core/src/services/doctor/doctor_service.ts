import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../../types/contracts.js'
import type { TenantRepositoryContract } from '../../types/contracts.js'
import type {
  DoctorCheck,
  DoctorContext,
  DoctorRunOptions,
  DoctorRunResult,
  DiagnosisReport,
} from './types.js'

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
    const repo =
      repoOverride ??
      ((await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract)

    const allTenants = await repo.all({ includeDeleted: true })
    const tenants =
      options.tenants && options.tenants.length > 0
        ? allTenants.filter((t) => options.tenants!.includes(t.id))
        : allTenants

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
