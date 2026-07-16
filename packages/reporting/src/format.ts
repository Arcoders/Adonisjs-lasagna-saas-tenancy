import type { ReportAggregate, TopTenantMetric, CustomMetricBreakdown } from './types.js'

export type ReportFormat = 'table' | 'json' | 'csv'

export const REPORT_FORMATS: readonly ReportFormat[] = ['table', 'json', 'csv']

export interface ReportPayload {
  aggregate: ReportAggregate[]
  topTenants: TopTenantMetric[]
  customMetrics?: CustomMetricBreakdown[]
}

/** Type guard for the `--format` flag. */
export function isReportFormat(value: unknown): value is ReportFormat {
  return typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value)
}

/**
 * Render a report payload as a human table, JSON, or CSV. Pure. The unit tests
 * pin every branch, including CSV escaping and formula-injection neutralization,
 * so the riskiest output path (untrusted-ish metric names landing in a
 * spreadsheet) is covered.
 */
export function formatReport(payload: ReportPayload, format: ReportFormat = 'table'): string {
  switch (format) {
    case 'json':
      return formatJson(payload)
    case 'csv':
      return formatCsv(payload)
    case 'table':
    default:
      return formatTable(payload)
  }
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function formatJson(payload: ReportPayload): string {
  return JSON.stringify(payload, null, 2)
}

function formatTable(payload: ReportPayload): string {
  const lines: string[] = []
  lines.push('=== usage by period ===')
  if (payload.aggregate.length === 0) lines.push('(no data)')
  for (const r of payload.aggregate) {
    lines.push(
      `${r.period}  requests=${r.totalRequests}  errors=${r.totalErrors}  ` +
        `errorRate=${pct(r.errorRate)}  tenants=${r.activeTenants}`
    )
  }
  lines.push('', '=== top tenants ===')
  if (payload.topTenants.length === 0) lines.push('(no data)')
  for (const t of payload.topTenants) {
    lines.push(
      `${t.tenantId}  requests=${t.requests}  errors=${t.errors}  errorRate=${pct(t.errorRate)}`
    )
  }
  if (payload.customMetrics) {
    lines.push('', '=== custom metrics ===')
    if (payload.customMetrics.length === 0) lines.push('(no data)')
    for (const m of payload.customMetrics) {
      lines.push(`${m.name}  total=${m.total}`)
    }
  }
  return lines.join('\n')
}

function formatCsv(payload: ReportPayload): string {
  const blocks: string[] = []

  blocks.push(
    csvBlock(
      'period',
      [
        'period',
        'totalRequests',
        'totalErrors',
        'totalBandwidthBytes',
        'activeTenants',
        'errorRate',
      ],
      payload.aggregate.map((r) => [
        r.period,
        r.totalRequests,
        r.totalErrors,
        r.totalBandwidthBytes,
        r.activeTenants,
        r.errorRate,
      ])
    )
  )

  blocks.push(
    csvBlock(
      'topTenants',
      ['tenantId', 'requests', 'errors', 'bandwidthBytes', 'errorRate'],
      payload.topTenants.map((t) => [
        t.tenantId,
        t.requests,
        t.errors,
        t.bandwidthBytes,
        t.errorRate,
      ])
    )
  )

  if (payload.customMetrics) {
    blocks.push(
      csvBlock(
        'customMetrics',
        ['name', 'total'],
        payload.customMetrics.map((m) => [m.name, m.total])
      )
    )
  }

  return blocks.join('\n\n')
}

function csvBlock(section: string, header: string[], rows: unknown[][]): string {
  const lines = [`# ${section}`, header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return lines.join('\n')
}

/**
 * RFC 4180 quoting + CSV formula-injection neutralization. A cell beginning with
 * `=`, `+`, `-`, `@`, tab, or CR is prefixed with a single quote so a spreadsheet
 * can't execute it as a formula (a safe metric name like `-foo` is valid and
 * would otherwise be a vector). Then commas/quotes/newlines force quoting with
 * internal quotes doubled.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`
  }
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`
  }
  return s
}
