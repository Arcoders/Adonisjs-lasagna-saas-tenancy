import { test } from '@japa/runner'
import {
  ISTHMUS_BUDGETS,
  allowIsthmusEvent,
  __resetIsthmusRateLimit,
} from '../../../../src/isthmus/audit.js'
import type { IsthmusSeverity } from '../../../../src/types/isthmus.js'

/**
 * The Isthmus dispatch limiter: per-severity fixed windows with independent
 * state, so a burst at one severity can never starve another, and every budget
 * is finite (the contract spec pins that separately). Mirrors the proven
 * scope-bypass limiter mechanics (now-injectable, __reset seam, 10s window).
 */

const T0 = 1_000_000
const SEVERITIES: IsthmusSeverity[] = ['critical', 'high', 'warn', 'info']

test.group('Isthmus rate limiter — per-severity budgets', (group) => {
  group.each.setup(() => __resetIsthmusRateLimit())
  group.teardown(() => __resetIsthmusRateLimit())

  test('allows exactly the budget per window for each severity', ({ assert }) => {
    for (const severity of SEVERITIES) {
      __resetIsthmusRateLimit()
      const budget = ISTHMUS_BUDGETS[severity]
      let allowed = 0
      for (let i = 0; i < budget + 25; i++) {
        if (allowIsthmusEvent(severity, T0 + i)) allowed++
      }
      assert.equal(allowed, budget, `${severity} must allow exactly ${budget} per window`)
    }
  })

  test('a critical burst does not consume the high budget (independent windows)', ({ assert }) => {
    for (let i = 0; i < ISTHMUS_BUDGETS.critical + 50; i++) {
      allowIsthmusEvent('critical', T0 + i)
    }
    let highAllowed = 0
    for (let i = 0; i < ISTHMUS_BUDGETS.high; i++) {
      if (allowIsthmusEvent('high', T0 + i)) highAllowed++
    }
    assert.equal(highAllowed, ISTHMUS_BUDGETS.high)
  })

  test('the window resets after WINDOW_MS', ({ assert }) => {
    for (let i = 0; i < ISTHMUS_BUDGETS.warn; i++) {
      allowIsthmusEvent('warn', T0)
    }
    assert.isFalse(allowIsthmusEvent('warn', T0 + 9_999), 'still inside the window')
    assert.isTrue(allowIsthmusEvent('warn', T0 + 10_001), 'a new window opens a fresh budget')
  })

  test('__reset restores a clean window', ({ assert }) => {
    for (let i = 0; i < ISTHMUS_BUDGETS.info + 5; i++) {
      allowIsthmusEvent('info', T0)
    }
    assert.isFalse(allowIsthmusEvent('info', T0))
    __resetIsthmusRateLimit()
    assert.isTrue(allowIsthmusEvent('info', T0))
  })
})
