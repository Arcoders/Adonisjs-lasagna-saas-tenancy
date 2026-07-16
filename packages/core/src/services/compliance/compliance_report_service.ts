import app from '@adonisjs/core/services/app'
import { Database } from '@adonisjs/lucid/database'
import { getConfig } from '../../config.js'
import type {
  ComplianceContext,
  ComplianceControl,
  ComplianceReport,
  ComplianceRunOptions,
  ControlResult,
} from './types.js'

/**
 * Registry of compliance posture controls, modelled one-to-one on
 * `DoctorService`. Core seeds the built-in controls at boot; satellites can
 * `register()` their own in their provider's `boot()` (the way the backup
 * package registers `backupRecencyCheck` into `DoctorService`), so the report
 * stays current as the ecosystem grows without editing this file.
 */
export default class ComplianceReportService {
  readonly #controls = new Map<string, ComplianceControl>()

  register(control: ComplianceControl): this {
    this.#controls.set(control.id, control)
    return this
  }

  unregister(id: string): this {
    this.#controls.delete(id)
    return this
  }

  has(id: string): boolean {
    return this.#controls.has(id)
  }

  list(): ComplianceControl[] {
    return [...this.#controls.values()]
  }

  /**
   * Run the registered controls and aggregate their results. `ctxOverride` lets
   * tests run the registry against a doubled context without an Ignitor (mirrors
   * `DoctorService.run(options, repoOverride)`).
   */
  async run(
    options: ComplianceRunOptions = {},
    ctxOverride?: ComplianceContext
  ): Promise<ComplianceReport> {
    const framework = (options.framework ?? 'all').toLowerCase()
    const selected =
      options.controls && options.controls.length > 0 ? new Set(options.controls) : null

    const controls = [...this.#controls.values()].filter((c) => {
      if (selected) return selected.has(c.id)
      if (framework === 'all') return true
      return c.frameworks.some((f) => f.split(':')[0] === framework)
    })

    const ctx: ComplianceContext = ctxOverride ?? {
      config: getConfig(),
      db: await app.container.make(Database),
    }

    const results: ControlResult[] = []
    const totals = { satisfied: 0, actionNeeded: 0, info: 0 }

    for (const control of controls) {
      let detection
      try {
        detection = await control.detect(ctx)
      } catch (error: any) {
        detection = {
          status: 'action-needed' as const,
          evidence: `Control check threw: ${error?.message ?? 'unknown error'}`,
          hostResponsibility: 'Investigate why this posture check could not run.',
        }
      }

      const result: ControlResult = {
        id: control.id,
        title: control.title,
        frameworks: control.frameworks,
        ...detection,
      }
      results.push(result)

      if (result.status === 'satisfied') totals.satisfied++
      else if (result.status === 'action-needed') totals.actionNeeded++
      else totals.info++
    }

    return { controls: results, totals }
  }
}
