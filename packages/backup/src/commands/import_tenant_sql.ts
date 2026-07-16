import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import SqlImportService from '../services/sql_import_service.js'

export default class ImportTenantSql extends BaseCommand {
  static readonly commandName = 'tenant:import'
  static readonly description = 'Import a PostgreSQL .sql dump file into a tenant schema'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ alias: 't', flagName: 'tenant', description: 'Target tenant ID', required: true })
  declare tenant: string

  @flags.string({
    alias: 'f',
    flagName: 'file',
    description: 'Path to the .sql dump file',
    required: true,
  })
  declare file: string

  @flags.string({
    flagName: 'schema-replace',
    description:
      "Source schema in the dump to rewrite to the tenant schema (pg_dump emits 'public' by default)",
    default: 'public',
  })
  declare schemaReplace: string

  @flags.boolean({
    flagName: 'dry-run',
    description: 'Parse file and report counts without executing',
    default: false,
  })
  declare dryRun: boolean

  @flags.boolean({
    flagName: 'verbose',
    description: 'Print each failed statement',
    default: false,
  })
  declare verbose: boolean

  @flags.boolean({
    flagName: 'force',
    description: 'Allow import into non-active tenants',
    default: false,
  })
  declare force: boolean

  // Distinct from --force on purpose: forcing an import into a non-active tenant
  // must NOT also silently disable the data-corruption guard. This flag alone
  // proceeds past the refusal when the schema rewrite would alter a source-schema
  // reference inside a string literal.
  @flags.boolean({
    flagName: 'allow-unsafe-rewrite',
    description:
      'Proceed even when the schema rewrite would alter a source-schema reference inside a string ' +
      'literal (risks corrupting that value; prefer re-exporting with `pg_dump --inserts`)',
    default: false,
  })
  declare allowUnsafeRewrite: boolean

  // Strict (all-or-nothing) is the DEFAULT: a restore either fully applies or
  // leaves nothing behind. Continuing past failures can leave the tenant
  // partially imported, so it is the explicit opt-out.
  @flags.boolean({
    flagName: 'continue-on-error',
    description:
      'Apply each statement in its own savepoint and continue past failures (may leave a PARTIAL import; the default aborts and rolls back on the first error)',
    default: false,
  })
  declare continueOnError: boolean

  async run() {
    const repo = await resolveTenantRepository()

    let tenant: TenantModelContract
    try {
      tenant = await repo.findByIdOrFail(this.tenant)
    } catch {
      this.logger.error(`Tenant "${this.tenant}" not found.`)
      this.exitCode = 1
      return
    }

    if (!tenant.isActive && !this.force) {
      this.logger.error(
        `Tenant "${tenant.name}" is not active (status: ${tenant.status}). Use --force to override.`
      )
      this.exitCode = 1
      return
    }

    const filePath = resolve(this.file)
    try {
      await access(filePath)
    } catch {
      this.logger.error(`File not found: ${filePath}`)
      this.exitCode = 1
      return
    }

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath

    if (this.dryRun) {
      this.logger.info(`Dry run — no changes will be made.`)
    }

    const service = new SqlImportService()
    const tasks = this.ui.tasks({ verbose: this.verbose })
    let result: Awaited<ReturnType<typeof service.import>>

    await tasks
      .add(
        `${this.dryRun ? '[dry-run] ' : ''}Importing ${fileName} → ${tenant.schemaName}`,
        async (task) => {
          task.update('Reading and parsing SQL file…')
          try {
            result = await service.import(tenant, filePath, {
              sourceSchema: this.schemaReplace,
              dryRun: this.dryRun,
              strict: !this.continueOnError,
              force: this.allowUnsafeRewrite,
            })
            return result.errors.length > 0 ? task.error('completed with errors') : 'completed'
          } catch (err: any) {
            // A thrown import (strict abort, missing psql, etc.) must still
            // surface as a failed command, not a silent success.
            this.exitCode = 1
            return task.error(err.message)
          }
        }
      )
      .run()

    if (!result!) return

    this.logger.info(`  Statements : ${result.statementsTotal} total`)
    this.logger.info(`  Executed   : ${result.statementsExecuted}`)
    this.logger.info(`  Skipped    : ${result.statementsSkipped}`)
    this.logger.info(`  Errors     : ${result.errors.length}`)

    // Data-integrity flags (e.g. the schema rewrite touched a string literal)
    // are loud even on a "successful" import. A silently mutated value in a
    // restore is worse than a visible failure.
    for (const warning of result.warnings) {
      this.logger.warning(`  [WARN] ${warning}`)
    }

    if (result.errors.length > 0) {
      if (this.verbose) {
        for (const { statement, message } of result.errors) {
          this.logger.error(`  [ERR] ${message}`)
          this.logger.error(`        ${statement}`)
        }
      } else {
        this.logger.warning(`Re-run with --verbose to see failed statements.`)
      }
      this.exitCode = 1
    }
  }
}
