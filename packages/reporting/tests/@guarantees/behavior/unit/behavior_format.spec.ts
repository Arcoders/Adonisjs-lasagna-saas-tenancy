import { test } from '@japa/runner'
import {
  formatReport,
  csvCell,
  isReportFormat,
  type ReportPayload,
} from '../../../../src/format.js'

const sample: ReportPayload = {
  aggregate: [
    {
      period: '2026-06-01',
      totalRequests: 100,
      totalErrors: 5,
      totalBandwidthBytes: 2048,
      activeTenants: 3,
      errorRate: 0.05,
    },
  ],
  topTenants: [
    {
      tenantId: '11111111-1111-4111-8111-111111111111',
      requests: 80,
      errors: 4,
      bandwidthBytes: 1024,
      errorRate: 0.05,
    },
  ],
  customMetrics: [{ name: 'bookings', total: 12 }],
}

const empty: ReportPayload = { aggregate: [], topTenants: [], customMetrics: [] }

test.group('formatReport — json', () => {
  test('round-trips to a deep-equal object', ({ assert }) => {
    const out = formatReport(sample, 'json')
    assert.deepEqual(JSON.parse(out), sample)
  })

  test('empty data is still valid JSON', ({ assert }) => {
    assert.deepEqual(JSON.parse(formatReport(empty, 'json')), empty)
  })
})

test.group('formatReport — table', () => {
  test('renders human sections with values', ({ assert }) => {
    const out = formatReport(sample, 'table')
    assert.include(out, '=== usage by period ===')
    assert.include(out, 'requests=100')
    assert.include(out, '=== top tenants ===')
    assert.include(out, '=== custom metrics ===')
    assert.include(out, 'bookings  total=12')
  })

  test('empty data shows (no data)', ({ assert }) => {
    const out = formatReport(empty, 'table')
    assert.include(out, '(no data)')
  })
})

test.group('formatReport — csv', () => {
  test('emits labeled blocks with headers + rows', ({ assert }) => {
    const out = formatReport(sample, 'csv')
    assert.include(out, '# period')
    assert.include(
      out,
      'period,totalRequests,totalErrors,totalBandwidthBytes,activeTenants,errorRate'
    )
    assert.include(out, '# topTenants')
    assert.include(out, '# customMetrics')
    assert.include(out, 'bookings,12')
  })

  test('empty data yields header-only blocks (no throw)', ({ assert }) => {
    const out = formatReport(empty, 'csv')
    assert.include(out, '# period')
    assert.include(out, 'name,total')
  })
})

test.group('csvCell — RFC4180 + formula-injection neutralization', () => {
  test('quotes commas, quotes, and newlines', ({ assert }) => {
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell('he said "hi"'), '"he said ""hi"""')
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"')
  })

  // CHAOS: a safe metric name like `-foo` starts with a formula char and must be
  // neutralized so a spreadsheet can't execute it.
  test('neutralizes leading = + - @ with a single quote', ({ assert }) => {
    assert.equal(csvCell('=1+1'), "'=1+1")
    assert.equal(csvCell('+x'), "'+x")
    assert.equal(csvCell('-foo'), "'-foo")
    assert.equal(csvCell('@cmd'), "'@cmd")
  })

  test('a formula char + a comma gets both treatments', ({ assert }) => {
    // neutralized to '=a,b then quoted because of the comma
    assert.equal(csvCell('=a,b'), `"'=a,b"`)
  })

  test('plain values pass through unchanged', ({ assert }) => {
    assert.equal(csvCell('bookings'), 'bookings')
    assert.equal(csvCell(42), '42')
    assert.equal(csvCell(null), '')
  })
})

test.group('isReportFormat', () => {
  test('guards the format whitelist', ({ assert }) => {
    assert.isTrue(isReportFormat('csv'))
    assert.isFalse(isReportFormat('yaml'))
    assert.isFalse(isReportFormat(undefined))
  })
})
