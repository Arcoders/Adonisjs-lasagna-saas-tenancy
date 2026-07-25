import type { AiAuditEntry } from '../services/ai_audit_writer.js'

/**
 * The flat, serialization-ready shape of one exported AI audit row.
 * Every field is a string / number / boolean / null so the NDJSON and CSV emitters
 * share one record type. It carries the three chain fields (`seq`, `checksum`,
 * `prevChecksum`) so an EXTERNAL verifier can re-walk the file with no live database:
 * recompute `canonicalAuditFields`/`auditChecksum` per row and link through the exported
 * `prevChecksum`. No prompt/response/query/document/tool text is ever present (it is not
 * on the entry); `principalHash`/`sourceHash` are one-way SHA-256.
 */
export interface AiAuditExportRecord {
  id: string
  tenantId: string
  seq: number
  checksum: string
  prevChecksum: string | null
  op: string
  outcome: string
  reason: string | null
  principalHash: string | null
  sourceHash: string | null
  provider: string | null
  model: string | null
  tokens: number
  fragments: number
  embeddingsCount: number
  dimension: number
  matchCount: number
  idempotentReplay: boolean
  occurredAt: string
}

/** Stable column order, shared by the CSV header and every CSV row. */
export const AI_AUDIT_EXPORT_COLUMNS = [
  'id',
  'tenantId',
  'seq',
  'checksum',
  'prevChecksum',
  'op',
  'outcome',
  'reason',
  'principalHash',
  'sourceHash',
  'provider',
  'model',
  'tokens',
  'fragments',
  'embeddingsCount',
  'dimension',
  'matchCount',
  'idempotentReplay',
  'occurredAt',
] as const satisfies ReadonlyArray<keyof AiAuditExportRecord>

/** Project a persisted entry onto the flat export record. Pure, so it unit-tests without a db. */
export function auditEntryToRecord(entry: AiAuditEntry): AiAuditExportRecord {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    seq: entry.seq,
    checksum: entry.checksum,
    prevChecksum: entry.prevChecksum,
    op: entry.op,
    outcome: entry.outcome,
    reason: entry.reason,
    principalHash: entry.principalHash,
    sourceHash: entry.sourceHash,
    provider: entry.provider,
    model: entry.model,
    tokens: entry.tokens,
    fragments: entry.fragments,
    embeddingsCount: entry.embeddingsCount,
    dimension: entry.dimension,
    matchCount: entry.matchCount,
    idempotentReplay: entry.idempotentReplay,
    occurredAt: entry.occurredAt,
  }
}

/** One NDJSON line: a single JSON object, streamable and re-walkable line by line. */
export function toNdjsonLine(record: AiAuditExportRecord): string {
  return JSON.stringify(record)
}

/**
 * RFC 4180 quoting PLUS CSV formula-injection neutralization, reused verbatim from
 * core's audit export (`audit_export.ts`). A spreadsheet executes any cell that begins
 * with `=`, `+`, `-`, `@`, or a leading tab/CR, so a value planted in an audited field
 * (reason, provider, model) could run a formula on the analyst's machine when they open
 * the forensic export. Prefix an apostrophe so the cell is literal text, then RFC-4180 quote.
 */
function escapeCsv(value: string | null): string {
  if (value == null) return ''
  const cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`
  }
  return cell
}

/** Coerce a record value to the string an escaper/emitter sees (numbers/booleans stringified). */
function stringifyCell(value: string | number | boolean | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  return String(value)
}

export function csvHeader(): string {
  return AI_AUDIT_EXPORT_COLUMNS.join(',')
}

export function toCsvRow(record: AiAuditExportRecord): string {
  return AI_AUDIT_EXPORT_COLUMNS.map((col) => escapeCsv(stringifyCell(record[col]))).join(',')
}
