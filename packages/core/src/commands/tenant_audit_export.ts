import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import AuditLogService from '../services/audit_log_service.js'
import { auditRowToRecord, csvHeader, toCsvRow } from '../utils/audit_export.js'

/**
 * Export the immutable audit trail for auditors / GDPR Art.15 + Art.20. Streams
 * row batches and writes incrementally, so a tenant with millions of rows is
 * never held in memory. When writing to stdout (no `--out`), the data stream is
 * the only thing emitted, so it stays pipe-friendly.
 */
export default class TenantAuditExport extends BaseCommand {
  static readonly commandName = 'tenant:audit:export'
  static readonly description =
    'Export the immutable audit log as JSON or CSV (for auditors / GDPR data access & portability)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'tenant',
    description: 'Tenant ID to export. Omit to export every tenant (incl. system rows).',
  })
  declare tenant?: string

  @flags.string({ flagName: 'from', description: 'ISO 8601 lower bound on created_at (inclusive)' })
  declare from?: string

  @flags.string({ flagName: 'to', description: 'ISO 8601 upper bound on created_at (inclusive)' })
  declare to?: string

  @flags.string({ flagName: 'format', default: 'json', description: 'Output format: json | csv' })
  declare format: string

  @flags.string({
    flagName: 'out',
    description: 'Write to this file instead of stdout (overwritten if it exists)',
  })
  declare out?: string

  async run() {
    const format = this.format.toLowerCase()
    if (format !== 'json' && format !== 'csv') {
      this.logger.error(`Unknown --format "${this.format}". Use "json" or "csv".`)
      this.exitCode = 1
      return
    }

    const from = this.#parseDate(this.from, 'from')
    if (from === INVALID) return
    const to = this.#parseDate(this.to, 'to')
    if (to === INVALID) return

    const audit = await app.container.make(AuditLogService)
    const toFile = typeof this.out === 'string' && this.out.length > 0

    // One destination opened once (a file stream, or stdout) — never reopened
    // per row. `write` honors backpressure so a slow consumer can't make us
    // buffer the whole export in memory.
    const stream: Writable = toFile ? createWriteStream(this.out!) : process.stdout
    let streamError: Error | undefined
    stream.on('error', (err: Error) => {
      streamError = err
    })
    const write = async (chunk: string) => {
      if (streamError) throw streamError
      if (!stream.write(chunk)) await once(stream, 'drain')
    }

    try {
      await write(format === 'json' ? '[' : `${csvHeader()}\n`)

      let count = 0
      for await (const batch of audit.exportStream({
        tenantId: this.tenant,
        from,
        to,
        batchSize: 500,
      })) {
        for (const row of batch) {
          const record = auditRowToRecord(row)
          if (format === 'json') {
            await write(`${count === 0 ? '\n' : ',\n'}${JSON.stringify(record)}`)
          } else {
            await write(`${toCsvRow(record)}\n`)
          }
          count++
        }
      }

      if (format === 'json') await write(count === 0 ? ']\n' : '\n]\n')

      if (toFile) {
        stream.end()
        await new Promise<void>((resolve, reject) => {
          stream.on('finish', () => resolve())
          stream.on('error', reject)
        })
        // Only speak when stdout is free (writing to a file); otherwise the data
        // stream must be the sole stdout content for piping.
        this.logger.success(`Exported ${count} audit row(s) to ${this.out} (${format}).`)
      }
    } catch (error: any) {
      if (toFile) stream.destroy()
      this.logger.error(`Audit export failed: ${error?.message ?? 'unknown'}`)
      this.exitCode = 1
    }
  }

  #parseDate(value: string | undefined, flag: 'from' | 'to'): Date | undefined | typeof INVALID {
    if (!value) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      this.logger.error(`--${flag} "${value}" is not a valid ISO 8601 date.`)
      this.exitCode = 1
      return INVALID
    }
    return date
  }
}

const INVALID = Symbol('invalid-date')
