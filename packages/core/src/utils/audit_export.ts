import type TenantAuditLog from '../models/satellites/tenant_audit_log.js'

/**
 * Flat, serialization-ready shape of one audit row. Every field is a string or
 * `null` so JSON and CSV emitters share one record type. `metadata` is the JSONB
 * column rendered back to a JSON string (one CSV cell); `createdAt` is ISO 8601
 * in UTC for a reproducible, timezone-stable export.
 */
export interface AuditExportRecord {
  id: string
  tenantId: string | null
  actorType: string
  actorId: string | null
  action: string
  metadata: string | null
  ipAddress: string | null
  createdAt: string | null
}

/** Column order is stable and shared by the CSV header and every CSV row. */
export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'tenantId',
  'actorType',
  'actorId',
  'action',
  'metadata',
  'ipAddress',
  'createdAt',
] as const satisfies ReadonlyArray<keyof AuditExportRecord>

/**
 * Project an audit model row onto the flat export record. Pure — no app/db
 * access — so it unit-tests against a hand-built row without an Ignitor.
 */
export function auditRowToRecord(row: TenantAuditLog): AuditExportRecord {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    actorType: row.actorType,
    actorId: row.actorId ?? null,
    action: row.action,
    metadata: row.metadata == null ? null : JSON.stringify(row.metadata),
    ipAddress: row.ipAddress ?? null,
    createdAt: row.createdAt ? row.createdAt.toUTC().toISO() : null,
  }
}

/**
 * RFC 4180 quoting PLUS CSV formula-injection neutralization. A spreadsheet
 * (Excel/Sheets/LibreOffice) executes any cell that begins with `=`, `+`, `-`,
 * `@`, or a leading tab/CR. So a value planted in an audited field (action,
 * metadata, ip) could run a formula on the analyst's machine when they open the
 * forensic export. Neutralize by prefixing an apostrophe so the cell is treated
 * as literal text, then apply RFC-4180 quoting.
 */
function escapeCsv(value: string | null): string {
  if (value == null) return ''
  const cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`
  }
  return cell
}

export function csvHeader(): string {
  return AUDIT_EXPORT_COLUMNS.join(',')
}

export function toCsvRow(record: AuditExportRecord): string {
  return AUDIT_EXPORT_COLUMNS.map((col) => escapeCsv(record[col])).join(',')
}
