import { test } from '@japa/runner'
import { builtInChecks } from '../../../../src/services/doctor/checks/index.js'
import metricsFreshnessCheck from '../../../../src/services/doctor/checks/metrics_freshness_check.js'

test.group('metrics_freshness check — opt-in registration', () => {
  test('is NOT one of the always-on builtInChecks', ({ assert }) => {
    // A fresh / empty metrics table would warn forever, so this check is opt-in:
    // hosts running the metrics pipeline register it explicitly.
    assert.notInclude(
      builtInChecks.map((c) => c.name),
      'metrics_freshness'
    )
  })

  test('exposes a stable name + description', ({ assert }) => {
    assert.equal(metricsFreshnessCheck.name, 'metrics_freshness')
    assert.isString(metricsFreshnessCheck.description)
  })
})
