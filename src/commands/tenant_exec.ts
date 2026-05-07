import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type {
  TenantRepositoryContract,
  TenantModelContract,
  TenantStatus,
} from '../types/contracts.js'
import { tenancy } from '../tenancy.js'

/**
 * Run an arbitrary ace command in the context of one or more tenants. The
 * generic counterpart to `tenants:run` in `stancl/tenancy` for Laravel.
 *
 * For each tenant matching the filter, the inner command runs inside
 * `tenancy.run(tenant, fn)` so the active isolation driver routes
 * connections, AsyncLocalStorage logging is set, and any registered
 * bootstrappers fire.
 *
 * Selection:
 *   --tenant=<id>     repeat or pass a comma list to target specific tenants
 *   (no flag)         iterate ALL tenants via `repo.each()` (memory-safe)
 *   --status=active   restrict to one or more statuses
 *
 * @example
 *   node ace tenant:exec list:routes
 *   node ace tenant:exec --tenant=abc make:migration users
 *   node ace tenant:exec --status=active --continue-on-error db:seed
 *   node ace tenant:exec --dry-run db:wipe --force
 */
export default class TenantExec extends BaseCommand {
  static readonly commandName = 'tenant:exec'
  static readonly description =
    'Run any ace command inside one or more tenant contexts'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Ace command to run for each tenant (e.g. db:seed)' })
  declare command: string

  @args.spread({
    description: 'Arguments and flags forwarded verbatim to the inner command',
    required: false,
  })
  declare commandArgs?: string[]

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant ID(s) to target. Omit to iterate every tenant',
  })
  declare tenantsIds?: string[]

  @flags.array({
    flagName: 'status',
    required: false,
    description:
      'Filter by status (active|provisioning|suspended|failed|deleted). Repeatable',
  })
  declare statuses?: string[]

  @flags.boolean({
    flagName: 'include-deleted',
    default: false,
    description: 'Include soft-deleted tenants in the iteration',
  })
  declare includeDeleted: boolean

  @flags.number({
    flagName: 'limit',
    required: false,
    description: 'Stop after N tenants (debugging / partial rollouts)',
  })
  declare limit?: number

  @flags.number({
    flagName: 'batch-size',
    required: false,
    description: 'Cursor batch size for whole-population iteration (default 100)',
  })
  declare batchSize?: number

  @flags.boolean({
    flagName: 'continue-on-error',
    default: false,
    description: 'Keep going when a tenant fails (default: stop on first failure)',
  })
  declare continueOnError: boolean

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Print which tenants would run the command without executing it',
  })
  declare dryRun: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    const allowedStatuses = this.#parseStatuses()
    let succeeded = 0
    let failed = 0
    let visited = 0
    let aborted = false

    const handle = async (tenant: TenantModelContract): Promise<boolean> => {
      visited++
      if (this.dryRun) {
        this.logger.info(
          `[dry-run] ${tenant.id} (${tenant.name}) → ace ${this.command} ${(this.commandArgs ?? []).join(' ')}`.trim()
        )
        return true
      }
      try {
        await tenancy.run(tenant, async () => {
          const result = await this.kernel.exec(this.command, this.commandArgs ?? [])
          if (result.exitCode != null && result.exitCode !== 0) {
            throw new Error(`exit code ${result.exitCode}`)
          }
        })
        this.logger.success(`${tenant.id} (${tenant.name}) ✓`)
        return true
      } catch (error: any) {
        this.logger.error(`${tenant.id} (${tenant.name}) ✗ ${error.message}`)
        return false
      }
    }

    if (this.tenantsIds && this.tenantsIds.length > 0) {
      const tenants = await repo.whereIn(this.tenantsIds, this.includeDeleted)
      const filtered = allowedStatuses
        ? tenants.filter((t) => allowedStatuses.has(t.status))
        : tenants
      for (const tenant of filtered) {
        if (this.#hitLimit(visited)) break
        const ok = await handle(tenant)
        if (ok) succeeded++
        else {
          failed++
          if (!this.continueOnError) {
            aborted = true
            break
          }
        }
      }
    } else {
      // Whole-population path — uses the cursor-paginated each() helper
      // so we don't load every tenant into memory at once.
      try {
        await repo.each(
          async (tenant) => {
            if (this.#hitLimit(visited)) {
              throw new Error('__limit_reached__')
            }
            const ok = await handle(tenant)
            if (ok) succeeded++
            else {
              failed++
              if (!this.continueOnError) {
                aborted = true
                throw new Error('__abort_on_error__')
              }
            }
          },
          {
            batchSize: this.batchSize,
            statuses: allowedStatuses ? ([...allowedStatuses] as TenantStatus[]) : undefined,
            includeDeleted: this.includeDeleted,
          }
        )
      } catch (error: any) {
        // Internal sentinels — re-throw real errors.
        if (
          error?.message !== '__abort_on_error__' &&
          error?.message !== '__limit_reached__'
        ) {
          throw error
        }
      }
    }

    this.logger.info(
      `Done: ${succeeded} succeeded, ${failed} failed, ${visited} visited` +
        (aborted ? ' (aborted on first failure — pass --continue-on-error to walk past)' : '')
    )
    if (failed > 0) this.exitCode = 1
  }

  #hitLimit(visited: number): boolean {
    return this.limit != null && this.limit >= 0 && visited >= this.limit
  }

  #parseStatuses(): Set<string> | undefined {
    if (!this.statuses || this.statuses.length === 0) return undefined
    return new Set(this.statuses.flatMap((s) => s.split(',').map((x) => x.trim())))
  }
}
