import { test } from '@japa/runner'
import {
  monthOf,
  isFirstOfMonth,
  isLastOfMonth,
  coversClosedMonthWindow,
  chooseAggregateSource,
  chooseTopTenantsSource,
  type RollupCoverageInput,
} from '../../../../src/rollup_source.js'

// A fully-eligible base: Jan–Mar 2026 (all closed), rollup spans them, today is June.
const ELIGIBLE: RollupCoverageInput = {
  since: '2026-01-01',
  until: '2026-03-31',
  rollupMin: '2026-01-01',
  rollupMax: '2026-03-01',
  asOfMonth: '2026-06-01',
}

test.group('rollup_source — month helpers (UTC)', () => {
  test('monthOf / isFirstOfMonth / isLastOfMonth', ({ assert }) => {
    assert.equal(monthOf('2026-03-30'), '2026-03-01')
    assert.isTrue(isFirstOfMonth('2026-03-01'))
    assert.isFalse(isFirstOfMonth('2026-03-02'))
    assert.isTrue(isLastOfMonth('2026-03-31'))
    assert.isTrue(isLastOfMonth('2024-02-29')) // leap
    assert.isTrue(isLastOfMonth('2026-02-28')) // non-leap last day
    assert.isFalse(isLastOfMonth('2026-03-30'))
  })

  test('month math is UTC, not affected by local DST', ({ assert }) => {
    assert.equal(monthOf('2026-10-25'), '2026-10-01')
    assert.isTrue(isLastOfMonth('2026-10-31'))
  })
})

test.group('rollup_source — chooseAggregateSource (path + chaos)', () => {
  test('1. enabled:false → live', ({ assert }) => {
    assert.equal(chooseAggregateSource({ ...ELIGIBLE, enabled: false, period: 'month' }), 'live')
  })
  test('2. period:day → live', ({ assert }) => {
    assert.equal(chooseAggregateSource({ ...ELIGIBLE, enabled: true, period: 'day' }), 'live')
  })
  test('3. period:week → live', ({ assert }) => {
    assert.equal(chooseAggregateSource({ ...ELIGIBLE, enabled: true, period: 'week' }), 'live')
  })
  test('4. since not first-of-month → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, since: '2026-01-15', enabled: true, period: 'month' }),
      'live'
    )
  })
  test('5. until not last-of-month → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, until: '2026-03-15', enabled: true, period: 'month' }),
      'live'
    )
  })
  test('6. empty rollup (min null) → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, rollupMin: null, enabled: true, period: 'month' }),
      'live'
    )
  })
  test('7. empty rollup (max null) → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, rollupMax: null, enabled: true, period: 'month' }),
      'live'
    )
  })
  test('8. rollup does not cover the lower edge → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({
        ...ELIGIBLE,
        rollupMin: '2026-02-01',
        enabled: true,
        period: 'month',
      }),
      'live'
    )
  })
  test('9. rollup does not cover the upper edge → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({
        ...ELIGIBLE,
        rollupMax: '2026-02-01',
        enabled: true,
        period: 'month',
      }),
      'live'
    )
  })
  test('10. CHAOS open period: until in the current month → live even with a stale row', ({
    assert,
  }) => {
    assert.equal(
      chooseAggregateSource({
        since: '2026-01-01',
        until: '2026-06-30',
        rollupMin: '2026-01-01',
        rollupMax: '2026-06-01', // a stale open-month row exists
        asOfMonth: '2026-06-01',
        enabled: true,
        period: 'month',
      }),
      'live'
    )
  })
  test('11. CHAOS future window → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({
        ...ELIGIBLE,
        until: '2026-07-31',
        rollupMax: '2026-07-01',
        enabled: true,
        period: 'month',
      }),
      'live'
    )
  })
  test('12. all conditions true, last month closed → rollup', ({ assert }) => {
    assert.equal(chooseAggregateSource({ ...ELIGIBLE, enabled: true, period: 'month' }), 'rollup')
  })
  test('14. boundary: until is endOfMonth-1 → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, until: '2026-03-30', enabled: true, period: 'month' }),
      'live'
    )
  })
  test('15. boundary: since first-of-month+1 → live', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({ ...ELIGIBLE, since: '2026-01-02', enabled: true, period: 'month' }),
      'live'
    )
  })
  test('16. boundary: rollupMax === untilMonth exactly and closed → rollup', ({ assert }) => {
    assert.equal(
      chooseAggregateSource({
        since: '2026-01-01',
        until: '2026-03-31',
        rollupMin: '2026-01-01',
        rollupMax: '2026-03-01',
        asOfMonth: '2026-04-01',
        enabled: true,
        period: 'month',
      }),
      'rollup'
    )
  })
  test('18. META: the open-month rule is the deciding factor', ({ assert }) => {
    // Same inputs as #10, but advance "today" so June is now closed and it flips to
    // rollup. Proves the open-month constraint (not some other rule) gates #10.
    const openMonthInputs: RollupCoverageInput = {
      since: '2026-01-01',
      until: '2026-06-30',
      rollupMin: '2026-01-01',
      rollupMax: '2026-06-01',
      asOfMonth: '2026-06-01',
    }
    assert.isFalse(coversClosedMonthWindow(openMonthInputs))
    assert.isTrue(coversClosedMonthWindow({ ...openMonthInputs, asOfMonth: '2026-07-01' }))
  })
})

test.group('rollup_source — chooseTopTenantsSource (no period gate)', () => {
  test('enabled + covered closed window → rollup', ({ assert }) => {
    assert.equal(chooseTopTenantsSource({ ...ELIGIBLE, enabled: true }), 'rollup')
  })
  test('enabled:false → live', ({ assert }) => {
    assert.equal(chooseTopTenantsSource({ ...ELIGIBLE, enabled: false }), 'live')
  })
  test('open-month window → live', ({ assert }) => {
    assert.equal(
      chooseTopTenantsSource({
        since: '2026-01-01',
        until: '2026-06-30',
        rollupMin: '2026-01-01',
        rollupMax: '2026-06-01',
        asOfMonth: '2026-06-01',
        enabled: true,
      }),
      'live'
    )
  })
  test('non-month-aligned window → live', ({ assert }) => {
    assert.equal(
      chooseTopTenantsSource({ ...ELIGIBLE, until: '2026-03-20', enabled: true }),
      'live'
    )
  })
})
