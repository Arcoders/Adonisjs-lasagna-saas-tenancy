import { test } from '@japa/runner'
import QuotaService from '../../../../src/services/quota_service.js'
import TelemetryService from '../../../../src/services/telemetry_service.js'
import {
  OBS_SPAN,
  OBS_EVENT,
  OBS_ATTR,
  OBS_ATTR_ALLOWLIST,
  RESERVE_OUTCOME,
} from '../../../../src/services/observability/names.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import { setupTestConfig, testConfig } from '../../../helpers/config.js'
import { AI_TAG } from '../../../helpers/tags.js'

/**
 * WS2 observability — the domain telemetry emitted by reserve/settle/release,
 * asserted at the TelemetryService seam (no OTel SDK needed). Two contracts are
 * enforced behaviorally rather than by a fragile source regex:
 *   - span NAMES come from OBS_SPAN and events from OBS_EVENT (the stable
 *     dashboard/alert contract);
 *   - every attribute key is in OBS_ATTR_ALLOWLIST — ids/counts/outcomes only,
 *     never tenant content (G3). A future `setAttribute('prompt', …)` fails here.
 *
 * settle is per-fragment (hot): it records an event on the ACTIVE span, never its
 * own span, so we capture addEventOnActive separately.
 */
class StubQuotaService extends QuotaService {
  public evalResult: unknown = [1, 0, 0]
  protected async requireRedis(): Promise<any> {
    return {
      eval: async () =>
        typeof this.evalResult === 'function'
          ? (this.evalResult as () => unknown)()
          : this.evalResult,
    }
  }
}

interface CapturedSpan {
  name: string
  attrs: Record<string, unknown>
  setAttrs: Record<string, unknown>
  events: { name: string; attrs?: Record<string, unknown> | undefined }[]
}

function installCapture() {
  const spans: CapturedSpan[] = []
  const activeEvents: { name: string; attrs?: Record<string, unknown> | undefined }[] = []
  const origWithSpan = TelemetryService.withSpan
  const origActive = TelemetryService.addEventOnActive

  TelemetryService.withSpan = (async (
    name: string,
    attrs: Record<string, unknown>,
    fn: (span: unknown) => Promise<unknown>
  ) => {
    const rec: CapturedSpan = { name, attrs: { ...attrs }, setAttrs: {}, events: [] }
    spans.push(rec)
    const span: any = {
      setAttribute: (k: string, v: unknown) => ((rec.setAttrs[k] = v), span),
      addEvent: (n: string, a?: Record<string, unknown>) => (
        rec.events.push({ name: n, attrs: a }),
        span
      ),
      addLink: () => span,
      setStatus: () => span,
      recordException: () => span,
      end: () => {},
    }
    return fn(span)
  }) as never
  TelemetryService.addEventOnActive = ((n: string, a?: Record<string, unknown>) => {
    activeEvents.push({ name: n, attrs: a })
  }) as never

  const restore = () => {
    TelemetryService.withSpan = origWithSpan
    TelemetryService.addEventOnActive = origActive
  }
  return { spans, activeEvents, restore }
}

/** Every attribute key emitted across spans + active events. */
function emittedKeys(
  spans: CapturedSpan[],
  active: { attrs?: Record<string, unknown> | undefined }[]
): string[] {
  const keys = new Set<string>()
  for (const s of spans) {
    for (const k of Object.keys(s.attrs)) keys.add(k)
    for (const k of Object.keys(s.setAttrs)) keys.add(k)
    for (const e of s.events) for (const k of Object.keys(e.attrs ?? {})) keys.add(k)
  }
  for (const e of active) for (const k of Object.keys(e.attrs ?? {})) keys.add(k)
  return [...keys]
}

const handle = (over: Record<string, unknown> = {}) =>
  ({
    id: 'h1',
    tenantId: 't-1',
    quota: 'aiTokens',
    day: '2026-07-01',
    worstCase: 100,
    ttl: 1000,
    op: false,
    ...over,
  }) as never

test.group('QuotaService observability (WS2)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  let cap: ReturnType<typeof installCapture>

  group.each.setup(() => {
    setupTestConfig({
      ...testConfig,
      plans: { defaultPlan: 'p', definitions: { p: { limits: { aiTokens: 1000 } } } },
    } as never)
    cap = installCapture()
  })
  group.each.teardown(() => cap.restore())

  test('reserve opens a quota.reserve span with a hold_placed event and outcome=ok', async ({
    assert,
  }) => {
    const svc = new StubQuotaService()
    svc.evalResult = [1, 200, 0] // placed: [ok, tEff, oEff]
    await svc.reserve(buildTestTenant(), 'aiTokens', 100)

    assert.lengthOf(cap.spans, 1)
    const span = cap.spans[0]!
    assert.equal(span.name, OBS_SPAN.quotaReserve)
    assert.equal(span.attrs[OBS_ATTR.quota], 'aiTokens')
    assert.equal(span.setAttrs[OBS_ATTR.worstCase], 100)
    assert.equal(span.setAttrs[OBS_ATTR.outcome], RESERVE_OUTCOME.ok)
    const held = span.events.find((e) => e.name === OBS_EVENT.holdPlaced)
    assert.exists(held, 'a hold_placed event is recorded')
    assert.equal(held!.attrs?.[OBS_ATTR.effectiveTenant], 200)
  })

  test('settle records a settle event on the active span (no span of its own)', async ({
    assert,
  }) => {
    const svc = new StubQuotaService()
    svc.evalResult = [30, 30, 100] // [delta, newSettled, worst]
    await svc.settle(handle(), 30)

    assert.lengthOf(cap.spans, 0, 'settle must not open its own span (per-fragment, hot)')
    const evt = cap.activeEvents.find((e) => e.name === OBS_EVENT.settle)
    assert.exists(evt, 'a settle event lands on the active span')
    assert.equal(evt!.attrs?.[OBS_ATTR.delta], 30)
    assert.equal(evt!.attrs?.[OBS_ATTR.clamped], false)
  })

  test('settle marks clamped=true when the requested total exceeds worstCase', async ({
    assert,
  }) => {
    const svc = new StubQuotaService()
    svc.evalResult = [100, 100, 100]
    await svc.settle(handle(), 150) // over worstCase 100 => clamped
    const evt = cap.activeEvents.find((e) => e.name === OBS_EVENT.settle)
    assert.equal(evt!.attrs?.[OBS_ATTR.clamped], true)
  })

  test('release opens a quota.release span carrying the freed remainder', async ({ assert }) => {
    const svc = new StubQuotaService()
    svc.evalResult = [70]
    const freed = await svc.release(handle())
    assert.equal(freed, 70)
    assert.lengthOf(cap.spans, 1)
    assert.equal(cap.spans[0]!.name, OBS_SPAN.quotaRelease)
    const evt = cap.spans[0]!.events.find((e) => e.name === OBS_EVENT.release)
    assert.equal(evt!.attrs?.[OBS_ATTR.freed], 70)
  })

  test('every emitted attribute key is in the non-PII allowlist (G3, no content)', async ({
    assert,
  }) => {
    const svc = new StubQuotaService()
    svc.evalResult = [1, 200, 50]
    await svc.reserve(buildTestTenant(), 'aiTokens', 100)
    svc.evalResult = [30, 30, 100]
    await svc.settle(handle(), 30)
    svc.evalResult = [70]
    await svc.release(handle())

    for (const key of emittedKeys(cap.spans, cap.activeEvents)) {
      assert.include(
        OBS_ATTR_ALLOWLIST,
        key,
        `attribute "${key}" is not in the non-PII allowlist — telemetry must carry ids/counts/outcomes only`
      )
    }
  })
})

test.group('TelemetryService helpers (WS2)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))

  test('addLink links a span to another span context', ({ assert }) => {
    let linked: unknown
    const span: any = { addLink: (l: unknown) => (linked = l) }
    const ctx = { traceId: 't', spanId: 's' } as never
    TelemetryService.addLink(span, ctx)
    assert.deepEqual(linked, { context: ctx })
  })

  test('addEvent delegates to the span', ({ assert }) => {
    const events: { name: string; attrs?: unknown }[] = []
    const span: any = { addEvent: (name: string, attrs?: unknown) => events.push({ name, attrs }) }
    TelemetryService.addEvent(span, OBS_EVENT.holdPlaced, { [OBS_ATTR.freed]: 1 })
    assert.deepEqual(events, [{ name: OBS_EVENT.holdPlaced, attrs: { [OBS_ATTR.freed]: 1 } }])
  })
})
