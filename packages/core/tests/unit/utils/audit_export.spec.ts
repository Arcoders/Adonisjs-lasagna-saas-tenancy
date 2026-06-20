import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  auditRowToRecord,
  csvHeader,
  toCsvRow,
  AUDIT_EXPORT_COLUMNS,
} from '../../../src/utils/audit_export.js'
import type TenantAuditLog from '../../../src/models/satellites/tenant_audit_log.js'

function row(overrides: Partial<Record<string, unknown>> = {}): TenantAuditLog {
  return {
    id: 'id-1',
    tenantId: 't-1',
    actorType: 'admin',
    actorId: 'actor-1',
    action: 'subscription.upgraded',
    metadata: null,
    ipAddress: '203.0.113.7',
    createdAt: DateTime.fromISO('2026-01-02T03:04:05Z', { zone: 'utc' }),
    ...overrides,
  } as unknown as TenantAuditLog
}

test.group('audit_export — auditRowToRecord', () => {
  test('projects every field onto a flat string|null record', ({ assert }) => {
    const r = auditRowToRecord(row())
    assert.equal(r.id, 'id-1')
    assert.equal(r.tenantId, 't-1')
    assert.equal(r.actorType, 'admin')
    assert.equal(r.actorId, 'actor-1')
    assert.equal(r.action, 'subscription.upgraded')
    assert.equal(r.ipAddress, '203.0.113.7')
  })

  test('renders createdAt as ISO 8601 in UTC', ({ assert }) => {
    const r = auditRowToRecord(row({ createdAt: DateTime.fromISO('2026-06-20T10:00:00+02:00') }))
    assert.equal(r.createdAt, '2026-06-20T08:00:00.000Z')
  })

  test('JSON-stringifies metadata into a single cell', ({ assert }) => {
    const r = auditRowToRecord(row({ metadata: { fromPlan: 'starter', toPlan: 'pro' } }))
    assert.equal(r.metadata, '{"fromPlan":"starter","toPlan":"pro"}')
  })

  test('keeps null fields as null (not the string "null")', ({ assert }) => {
    const r = auditRowToRecord(
      row({ tenantId: null, actorId: null, ipAddress: null, metadata: null })
    )
    assert.isNull(r.tenantId)
    assert.isNull(r.actorId)
    assert.isNull(r.ipAddress)
    assert.isNull(r.metadata)
  })
})

test.group('audit_export — CSV', () => {
  test('header lists the columns in the canonical order', ({ assert }) => {
    assert.equal(csvHeader(), AUDIT_EXPORT_COLUMNS.join(','))
    assert.equal(csvHeader(), 'id,tenantId,actorType,actorId,action,metadata,ipAddress,createdAt')
  })

  test('a plain row needs no quoting', ({ assert }) => {
    const cells = toCsvRow(auditRowToRecord(row({ metadata: null }))).split(',')
    assert.equal(cells[0], 'id-1')
    assert.equal(cells[4], 'subscription.upgraded')
  })

  test('null cells render empty, not the literal "null"', ({ assert }) => {
    const line = toCsvRow(
      auditRowToRecord(row({ tenantId: null, actorId: null, ipAddress: null, metadata: null }))
    )
    // id,,actorType,,action,,,createdAt
    assert.match(line, /^id-1,,admin,,subscription\.upgraded,,,/)
  })

  test('quotes and escapes cells with commas, quotes and real newlines (RFC 4180)', ({
    assert,
  }) => {
    // action holds a comma, a double-quote AND a real newline — all three triggers.
    const r = auditRowToRecord(row({ action: 'a,b "c"\nd', metadata: { note: 'has,comma' } }))
    const cells = parseCsvLine(toCsvRow(r))
    assert.equal(cells[4], 'a,b "c"\nd')
    assert.equal(cells[5], '{"note":"has,comma"}')
  })

  test('column count of a row always equals the header', ({ assert }) => {
    const headerCount = csvHeader().split(',').length
    const cells = parseCsvLine(toCsvRow(auditRowToRecord(row({ action: 'a,b,c' }))))
    assert.lengthOf(cells, headerCount)
  })
})

/** Minimal RFC 4180 single-record parser for asserting round-trips in tests. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}
