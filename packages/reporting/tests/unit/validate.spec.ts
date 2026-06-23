import { test } from '@japa/runner'
import {
  REPORT_PERIODS,
  isReportPeriod,
  resolvePeriod,
  isValidIsoDate,
} from '../../src/validate.js'

test.group('isReportPeriod', () => {
  test('accepts the three whitelisted periods', ({ assert }) => {
    for (const p of REPORT_PERIODS) assert.isTrue(isReportPeriod(p))
  })

  test('rejects anything else (the 400 path for the dashboard)', ({ assert }) => {
    assert.isFalse(isReportPeriod('foo'))
    assert.isFalse(isReportPeriod('DAY'))
    assert.isFalse(isReportPeriod(''))
    assert.isFalse(isReportPeriod(undefined))
    assert.isFalse(isReportPeriod(null))
    assert.isFalse(isReportPeriod(7))
  })
})

test.group('resolvePeriod (service fallback — never emit undefined into SQL)', () => {
  test('passes a valid period through', ({ assert }) => {
    assert.equal(resolvePeriod('week'), 'week')
    assert.equal(resolvePeriod('month'), 'month')
  })

  test('falls back to day for an out-of-enum / missing value', ({ assert }) => {
    assert.equal(resolvePeriod('foo'), 'day')
    assert.equal(resolvePeriod(undefined), 'day')
    assert.equal(resolvePeriod(null), 'day')
    assert.equal(resolvePeriod(''), 'day')
  })
})

test.group('isValidIsoDate', () => {
  test('accepts a real ISO YYYY-MM-DD date', ({ assert }) => {
    assert.isTrue(isValidIsoDate('2026-06-23'))
    assert.isTrue(isValidIsoDate('2000-01-01'))
  })

  test('rejects non-ISO shapes and impossible calendar dates', ({ assert }) => {
    assert.isFalse(isValidIsoDate('not-a-date'))
    assert.isFalse(isValidIsoDate('2026-13-40'))
    assert.isFalse(isValidIsoDate('06/23/2026'))
    assert.isFalse(isValidIsoDate('2026-6-3'))
    assert.isFalse(isValidIsoDate('2026-06-23T00:00:00Z'))
    assert.isFalse(isValidIsoDate(''))
  })
})
