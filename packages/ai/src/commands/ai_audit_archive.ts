import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import AiAuditReader from '../services/ai_audit_reader.js'
import AiAuditWriter from '../services/ai_audit_writer.js'
import { auditEntryToRecord, csvHeader, toCsvRow, toNdjsonLine } from '../utils/ai_audit_export.js'

/**
 * Archive a tenant's AI audit segment, the DEFAULT retention path that
 * PRUNES NOTHING. It (1) verifies the tenant's chain, refusing if it is already broken;
 * (2) exports the segment to the operator's WORM/SIEM file in chain order; (3) persists
 * a signed high-water-mark checkpoint `{ tenantId, lastSeq, lastChecksum }` into the
 * additive `ai_audit_checkpoints` table. No `ai_audit_logs` row is ever touched, so the
 * append-only invariant holds and a later incremental verify seeds from the checkpoint.
 *
 * Physical pruning (partition DETACH) is a SEPARATE, superuser-gated, off-by-default
 * path and is deliberately NOT wired here: most hosts should archive-and
 * -keep. Fail-closed: the checkpoint is written only after the export succeeds and the
 * chain verifies, because detaching or trusting a segment that was never anchored would
 * silently destroy evidence.
 */
export default class AiAuditArchive extends BaseCommand {
  static readonly commandName = 'tenant:ai:audit:archive'
  static readonly description =
    'Archive a tenant AI audit segment: verify, export to WORM/SIEM in chain order, then advance a signed checkpoint (prunes nothing)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({
    flagName: 'tenant',
    description: 'Tenant (uuid) to archive (required; a checkpoint is per-tenant)',
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
    description: 'Export format: ndjson | csv',
  })
  declare format: string

  @flags.string({ flagName: 'out', description: 'The WORM/SIEM destination file (required)' })
  declare out?: string

  async run() {
    const ai = getConfig().ai
    if (!ai || ai.audit?.enabled === false) {
      this.logger.log('AI audit is disabled (config.ai.audit.enabled = false); nothing to archive.')
      return
    }
    if (!this.tenant) {
      this.logger.error('--tenant <uuid> is required (a checkpoint is per-tenant).')
      this.exitCode = 1
      return
    }
    if (!this.out) {
      this.logger.error('--out <file> is required (the durable WORM/SIEM destination).')
      this.exitCode = 1
      return
    }
    const format = this.format.toLowerCase()
    if (format !== 'ndjson' && format !== 'csv') {
      this.logger.error(`Unknown --format "${this.format}". Use "ndjson" or "csv".`)
      this.exitCode = 1
      return
    }

    const writer = await this.app.container.make(AiAuditWriter)
    const reader = await this.app.container.make(AiAuditReader)

    // 1. Verify before archiving: never anchor a chain that is already broken.
    const verify = await writer.verify(this.tenant)
    if (!verify.ok) {
      const brk = verify.break!
      this.logger.error(
        `Refusing to archive tenant ${this.tenant}: the chain is BROKEN at seq ${brk.seq} (${brk.reason}). ` +
          `Investigate the tamper before archiving.`
      )
      this.exitCode = 1
      return
    }

    // 2. Export the segment in chain order, tracking the high-water mark.
    const stream: Writable = createWriteStream(this.out)
    let streamError: Error | undefined
    stream.on('error', (err: Error) => {
      streamError = err
    })
    const write = async (chunk: string) => {
      if (streamError) throw streamError
      if (!stream.write(chunk)) await once(stream, 'drain')
    }

    let count = 0
    let lastSeq = 0
    let lastChecksum: string | null = null
    try {
      if (format === 'csv') await write(`${csvHeader()}\n`)
      for await (const batch of reader.exportStream({
        tenantId: this.tenant,
        ...(this.from !== undefined ? { from: this.from } : {}),
        ...(this.to !== undefined ? { to: this.to } : {}),
      })) {
        for (const entry of batch) {
          const record = auditEntryToRecord(entry)
          await write(format === 'csv' ? `${toCsvRow(record)}\n` : `${toNdjsonLine(record)}\n`)
          lastSeq = entry.seq
          lastChecksum = entry.checksum
          count++
        }
      }
      stream.end()
      await new Promise<void>((resolve, reject) => {
        stream.on('finish', () => resolve())
        stream.on('error', reject)
      })
    } catch (error: any) {
      stream.destroy()
      this.logger.error(`AI audit archive export failed: ${error?.message ?? 'unknown'}`)
      this.exitCode = 1
      return
    }

    if (count === 0 || lastChecksum === null) {
      this.logger.log(
        `No rows in the requested segment for tenant ${this.tenant}; no checkpoint written.`
      )
      return
    }

    // 3. Advance the signed checkpoint (additive; never a chain row).
    await reader.writeCheckpoint(this.tenant, lastSeq, lastChecksum)
    this.logger.success(
      `Archived ${count} row(s) for tenant ${this.tenant} to ${this.out} (${format}); ` +
        `checkpoint advanced to seq ${lastSeq}. No rows were pruned.`
    )
  }
}
