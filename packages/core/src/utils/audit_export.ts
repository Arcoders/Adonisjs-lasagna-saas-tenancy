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

/** RFC 4180: quote a cell that holds a comma, quote, CR or LF; double inner quotes. */
function escapeCsv(value: string | null): string {
  if (value == null) return ''
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function csvHeader(): string {
  return AUDIT_EXPORT_COLUMNS.join(',')
}

export function toCsvRow(record: AuditExportRecord): string {
  return AUDIT_EXPORT_COLUMNS.map((col) => escapeCsv(record[col])).join(',')
}
