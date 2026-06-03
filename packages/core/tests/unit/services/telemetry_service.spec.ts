import { test } from '@japa/runner'
import TelemetryService from '../../../src/services/telemetry_service.js'

test.group('TelemetryService — withSpan', () => {
  test('executes the callback and returns its value', async ({ assert }) => {
    const result = await TelemetryService.withSpan('test.span', { env: 'test' }, async () => 42)
    assert.equal(result, 42)
  })

  test('propagates errors thrown inside callback', async ({ assert }) => {
    await assert.rejects(
      () =>
        TelemetryService.withSpan('test.error', {}, async () => {
          throw new Error('boom')
        }),
      /boom/
    )
  })

  test('works with async callbacks that return objects', async ({ assert }) => {
    const result = await TelemetryService.withSpan('test.object', {}, async () => ({
      ok: true,
      count: 3,
    }))
    assert.deepEqual(result, { ok: true, count: 3 })
  })

  test('setTenant does not throw when no active span', ({ assert }) => {
    assert.doesNotThrow(() => TelemetryService.setTenant('tenant-123'))
  })
})

test.group('TelemetryService — tracer', () => {
  test('returns a tracer instance', ({ assert }) => {
    const tracer = TelemetryService.tracer
    assert.exists(tracer)
  })

  test('returns same tracer instance on repeated calls', ({ assert }) => {
    const t1 = TelemetryService.tracer
    const t2 = TelemetryService.tracer
    assert.strictEqual(t1, t2)
  })
})
