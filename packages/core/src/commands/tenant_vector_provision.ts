import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { provisionVectorExtension } from '../services/isolation/vector_provisioning.js'

/**
 * Install the PostgreSQL `vector` (pgvector) extension where the active
 * isolation driver stores tenant data, under the privileged provisioning
 * connection (`isolation.provisionConnectionName`), never the app's
 * request-serving role. The DDL is dispatched by driver: once on the shared
 * database for `schema-pg`/`rowscope-pg`, and per tenant database for
 * `database-pg` (honouring `--tenant`). It is idempotent
 * (`CREATE EXTENSION IF NOT EXISTS`) and is the backfill for pre-existing
 * databases. Run it before any embeddings migration that declares a
 * `vector(N)` column.
 */
export default class TenantVectorProvision extends BaseCommand {
  static readonly commandName = 'tenant:vector:provision'
  static readonly description =
    'Install the pgvector extension under the privileged provisioning connection (per tenant database on database-pg, once on the shared database otherwise)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'dry-run',
    description: 'Report what would be provisioned without running CREATE EXTENSION',
    default: false,
  })
  declare dryRun: boolean

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant id(s) to provision (database-pg only). If omitted, all tenants',
  })
  declare tenantIds?: string[]

  async run() {
    const summary = await provisionVectorExtension({
      dryRun: this.dryRun,
      tenantIds: this.tenantIds,
      logger: {
        info: (m) => this.logger.info(m),
        warning: (m) => this.logger.warning(m),
      },
    })

    const verb = summary.dryRun ? 'would provision' : 'provisioned'
    this.logger.info(
      `pgvector: ${verb} ${summary.provisioned} database(s), ${summary.failed} failed ` +
        `(driver ${summary.driver}, scope ${summary.scope})`
    )
    if (summary.failed > 0) {
      this.logger.error(
        `${summary.failed} database(s) could not be provisioned; see the warnings above.`
      )
      this.exitCode = 1
      return
    }
    this.logger.success(summary.dryRun ? 'Dry run complete' : 'pgvector provisioning complete')
  }
}
