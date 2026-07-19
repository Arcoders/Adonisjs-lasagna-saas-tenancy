import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import AiAuditReader from '../services/ai_audit_reader.js'
import { auditEntryToRecord, csvHeader, toCsvRow, toNdjsonLine } from '../utils/ai_audit_export.js'

/**
 * Export the append-only AI audit hash chain in a form an external verifier can
 * re-walk (Wave 4, 3.2). Streams keyset-paged batches and writes incrementally with
 * backpressure, so a chain of millions of rows is never held in memory.
 *
 * Two departures from core's `tenant:audit:export`, each load-bearing:
 * - NDJSON (default), not a JSON array: one JSON object per line, streamable into a
 *   SIEM and re-walkable line by line. `--format csv` offers the spreadsheet form with
 *   formula-injection escaping.
 * - `(tenant_id, seq)` chain order, NOT `created_at`: only in chain order is the file
 *   self-verifiable — an external tool re-walks each tenant's rows, recomputing the
 *   checksum and linking through the exported `prevChecksum`, needing nothing live.
 *
 * Fail-closed on a write error: destroy the partial file and exit non-zero, because a
 * silently truncated forensic export is worse than a failed one.
 */
export default class AiAuditExport extends BaseCommand {
  static readonly commandName = 'tenant:ai:audit:export'
  static readonly description =
    'Export the append-only AI audit chain (NDJSON | CSV) in (tenant_id, seq) order for external re-verification'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'tenant',
    description: 'Export a single tenant (uuid); omit for every tenant',
  })
  declare tenant?: string

  @flags.string({
    flagName: 'from',
    description: 'ISO 8601 lower bound on occurred_at (inclusive)',
  })
  declare from?: string

  @flags.string({ flagName: 'to', description: 'ISO 8601 upper bound on occurred_at (inclusive)' })
  declare to?: string

  @flags.string({
    flagName: 'format',
    default: 'ndjson',
    description: 'Output format: ndjson | csv',
  })
  declare format: string

  @flags.string({
    flagName: 'out',
    description: 'Write to this file instead of stdout (overwritten if it exists)',
  })
  declare out?: string

  async run() {
    const ai = getConfig().ai
    if (!ai || ai.audit?.enabled === false) {
      this.logger.log('AI audit is disabled (config.ai.audit.enabled = false); nothing to export.')
      return
    }

    const format = this.format.toLowerCase()
    if (format !== 'ndjson' && format !== 'csv') {
      this.logger.error(`Unknown --format "${this.format}". Use "ndjson" or "csv".`)
      this.exitCode = 1
      return
    }

    const reader = await this.app.container.make(AiAuditReader)
    const toFile = typeof this.out === 'string' && this.out.length > 0
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
      if (format === 'csv') await write(`${csvHeader()}\n`)

      let count = 0
      for await (const batch of reader.exportStream({
        ...(this.tenant !== undefined ? { tenantId: this.tenant } : {}),
        ...(this.from !== undefined ? { from: this.from } : {}),
        ...(this.to !== undefined ? { to: this.to } : {}),
      })) {
        for (const entry of batch) {
          const record = auditEntryToRecord(entry)
          await write(format === 'csv' ? `${toCsvRow(record)}\n` : `${toNdjsonLine(record)}\n`)
          count++
        }
      }

      if (toFile) {
        stream.end()
        await new Promise<void>((resolve, reject) => {
          stream.on('finish', () => resolve())
          stream.on('error', reject)
        })
        this.logger.success(`Exported ${count} AI audit row(s) to ${this.out} (${format}).`)
      }
    } catch (error: any) {
      if (toFile) stream.destroy()
      this.logger.error(`AI audit export failed: ${error?.message ?? 'unknown'}`)
      this.exitCode = 1
    }
  }
}
