import { test } from '@japa/runner'
import { PLUGIN_METRIC } from '../../../../src/services/observability/plugin_names.js'

/**
 * A metric name is an operator-facing contract (dashboards/alerts key off it), so
 * it must not drift silently. This pins the exact wire values of the PLUGIN_METRIC
 * catalog; changing one here is a conscious, reviewed break.
 */
test.group('PLUGIN_METRIC catalog', () => {
  test('pins the metric wire names', ({ assert }) => {
    assert.deepEqual(
      { ...PLUGIN_METRIC },
      {
        dataChangeSubscriberErrors: 'data_change_subscriber_errors',
      }
    )
  })
})
