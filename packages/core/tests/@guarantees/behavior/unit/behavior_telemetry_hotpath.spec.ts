import { test } from '@japa/runner'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import TelemetryService from '../../../../src/services/telemetry_service.js'
import { tenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import BootstrapperRegistry from '../../../../src/services/bootstrapper_registry.js'
import {
  __setActiveDriverRegistryForTests,
  __resetActiveDriverCache,
} from '../../../../src/services/isolation/active_driver.js'

/**
 * WS-10 / no-otel-instrumentation-in-hot-path.
 *
 * `TelemetryService` exists, but before this fix nothing in the tenant
 * activation hot path opened a span or stamped `tenant.id`. A host that wires a
 * real OTel provider therefore saw NO tenant span at all. This drives the
 * background activation path (`tenancy.run`, the canonical non-HTTP entry) end
 * to end through a real in-memory OTel exporter and asserts a span carrying the
 * active `tenant.id` lands, and that it is the active span deeper code attaches
 * to.
 *
 * RED (pre-fix): `tenancy.run` opens no span; `getFinishedSpans()` is empty.
 */
test.group('OTel hot-path instrumentation — tenancy.run', (group) => {
  let provider: BasicTracerProvider
  let exporter: InMemorySpanExporter

  group.each.setup(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    // AsyncLocalStorage context manager so context.with() carries the active
    // span across awaits.
    context.disable()
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    trace.disable()
    trace.setGlobalTracerProvider(provider)
    ;(TelemetryService as unknown as { _tracer: null })._tracer = null
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
    // Deterministic no-op connect so the activation path runs without a real
    // backend (the real driver registry lives in the container).
    __setActiveDriverRegistryForTests({ active: () => ({ connect: async () => {} }) } as any)
  })

  group.each.teardown(async () => {
    await provider.shutdown()
    trace.disable()
    context.disable()
    ;(TelemetryService as unknown as { _tracer: null })._tracer = null
    __configureTenancyForTests({})
    __resetActiveDriverCache()
  })

  test('tenancy.run opens a span carrying the active tenant id', async ({ assert }) => {
    const tenant = { id: '11111111-1111-4111-8111-111111111111' } as any
    const result = await tenancy.run(tenant, async () => 'done')
    assert.equal(result, 'done')

    const finished = exporter.getFinishedSpans()
    const span = finished.find((s) => s.attributes['tenant.id'] === tenant.id)
    assert.isDefined(span, 'a span carrying the resolved tenant.id must be exported')
  })

  test('the tenancy span is the active span deeper code attaches to', async ({ assert }) => {
    const tenant = { id: '22222222-2222-4222-8222-222222222222' } as any
    await tenancy.run(tenant, async () => {
      // A span opened by code running inside the scope must parent onto the
      // tenancy span — proving the hot path establishes a real active context,
      // not just a detached attribute.
      await TelemetryService.withSpan('inner.work', {}, async () => 'x')
    })

    const finished = exporter.getFinishedSpans()
    const parent = finished.find((s) => s.attributes['tenant.id'] === tenant.id)
    const child = finished.find((s) => s.name === 'inner.work')
    assert.isDefined(parent, 'tenancy span must be exported')
    assert.isDefined(child, 'inner span must be exported')
    assert.equal(
      child!.parentSpanContext?.spanId ?? (child as any).parentSpanId,
      parent!.spanContext().spanId,
      'inner span must be a child of the tenancy span'
    )
  })

  test('a thrown error inside the scope is recorded on the tenancy span and re-raised', async ({
    assert,
  }) => {
    const tenant = { id: '33333333-3333-4333-8333-333333333333' } as any
    await assert.rejects(
      () =>
        tenancy.run(tenant, async () => {
          throw new Error('boom')
        }),
      /boom/
    )

    const finished = exporter.getFinishedSpans()
    const span = finished.find((s) => s.attributes['tenant.id'] === tenant.id)
    assert.isDefined(span, 'tenancy span must still be exported on failure')
    assert.equal(span!.status.code, 2, 'status.code must be ERROR (2)')
  })
})
