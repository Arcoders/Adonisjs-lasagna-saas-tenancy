import { test } from '@japa/runner'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { TelemetryService } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * End-to-end coverage for `TelemetryService` against a real OTel SDK
 * (`@opentelemetry/sdk-trace-base` with `InMemorySpanExporter`). The
 * unit suite asserts the wrapper's *control flow* (return value,
 * exception propagation); this spec asserts what actually lands in
 * the exporter — the part that matters in production.
 *
 * Without an SDK provider registered, `@opentelemetry/api`'s
 * `trace.getTracer()` returns a no-op tracer and `withSpan` produces
 * no observable telemetry. So this is the spec that proves the wiring
 * is correct when the host wires up a real provider.
 */
test.group('TelemetryService — span export with real OTel SDK', (group) => {
  let provider: BasicTracerProvider
  let exporter: InMemorySpanExporter

  group.each.setup(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    // `context.with()` only carries the active span across awaits when
    // a context manager backed by AsyncLocalStorage is installed —
    // OTel's no-op default doesn't preserve context. Without this,
    // `trace.getActiveSpan()` inside the callback returns `undefined`
    // (and `setTenant()` becomes a silent no-op, matching the unit
    // suite's expectation but useless for the export assertion).
    context.disable()
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    trace.disable()
    trace.setGlobalTracerProvider(provider)
    // Bust TelemetryService's cached tracer so it re-resolves against
    // our freshly-installed provider.
    ;(TelemetryService as unknown as { _tracer: null })._tracer = null
  })

  group.each.teardown(async () => {
    await provider.shutdown()
    trace.disable()
    context.disable()
    ;(TelemetryService as unknown as { _tracer: null })._tracer = null
  })

  test('withSpan exports a span with the supplied attributes', async ({ assert }) => {
    const result = await TelemetryService.withSpan('db.query', { table: 'users' }, async () => 42)
    assert.equal(result, 42)

    const finished = exporter.getFinishedSpans()
    assert.lengthOf(finished, 1, 'exactly one span must be exported')
    assert.equal(finished[0].name, 'db.query')
    assert.equal(finished[0].attributes['table'], 'users')
    // OK status when the callback resolves cleanly.
    assert.equal(finished[0].status.code, 1, 'status.code must be OK (1)')
  })

  test('setTenant adds tenant.id to the currently active span', async ({ assert }) => {
    await TelemetryService.withSpan('tenant.work', { region: 'eu-west-1' }, async () => {
      TelemetryService.setTenant('tenant-7')
    })

    const finished = exporter.getFinishedSpans()
    const span = finished.find((s) => s.name === 'tenant.work')!
    assert.equal(span.attributes['tenant.id'], 'tenant-7')
    assert.equal(span.attributes['region'], 'eu-west-1')
  })

  test('errors thrown inside the callback are recorded on the span and re-raised', async ({
    assert,
  }) => {
    await assert.rejects(
      () =>
        TelemetryService.withSpan('failing.op', {}, async () => {
          throw new Error('boom')
        }),
      /boom/
    )

    const finished = exporter.getFinishedSpans()
    assert.lengthOf(finished, 1)
    const span: ReadableSpan = finished[0]
    assert.equal(span.status.code, 2, 'status.code must be ERROR (2)')
    assert.match(String(span.status.message ?? ''), /boom/)
    // recordException() lands the error as a span event.
    const exEvent = span.events.find((e) => e.name === 'exception')
    assert.isDefined(exEvent, 'exception event must be recorded')
    assert.match(
      String((exEvent!.attributes as any)?.['exception.message'] ?? ''),
      /boom/
    )
  })

  test('nested withSpan calls produce parent/child relationships', async ({ assert }) => {
    await TelemetryService.withSpan('parent', {}, async () => {
      await TelemetryService.withSpan('child', {}, async () => 'inner')
    })

    const finished = exporter.getFinishedSpans()
    assert.lengthOf(finished, 2)
    const parent = finished.find((s) => s.name === 'parent')!
    const child = finished.find((s) => s.name === 'child')!
    // The child's parentSpanContext.spanId must equal the parent's
    // spanContext().spanId — that's how SimpleSpanProcessor links them.
    assert.equal(
      child.parentSpanContext?.spanId ?? (child as any).parentSpanId,
      parent.spanContext().spanId,
      'nested span must be linked to the surrounding scope'
    )
  })
})
