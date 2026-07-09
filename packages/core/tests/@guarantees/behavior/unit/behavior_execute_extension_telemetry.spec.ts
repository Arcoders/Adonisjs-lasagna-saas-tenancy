import { test } from '@japa/runner'
import {
  executeExtension,
  ExtensionTimeoutError,
} from '../../../../src/services/extensions/execute_extension.js'
import TelemetryService from '../../../../src/services/telemetry_service.js'
import {
  OBS_SPAN,
  OBS_ATTR,
  EXTENSION_OUTCOME,
} from '../../../../src/services/observability/names.js'
import { AI_TAG } from '../../../helpers/tags.js'

/**
 * WS2 observability — executeExtension emits one `extension.execute` span per
 * call whose `outcome` attribute classifies the terminal state. Asserted at the
 * TelemetryService seam; the behavioral contract (return values, rejections,
 * signal threading) stays covered by behavior_execute_extension.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FailingPipeline {
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    throw new Error('ECONNREFUSED — Redis is down')
  }
}
class CountingPipeline {
  constructor(private count: number) {}
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    return [
      [null, 0],
      [null, 0],
      [null, this.count],
      [null, 1],
    ]
  }
}
const redisWith = (pipeline: unknown) => async () => ({ pipeline: () => pipeline })

function installCapture() {
  const spans: { name: string; outcome?: unknown }[] = []
  const orig = TelemetryService.withSpan
  TelemetryService.withSpan = (async (
    name: string,
    _attrs: unknown,
    fn: (span: unknown) => Promise<unknown>
  ) => {
    const rec: { name: string; outcome?: unknown } = { name }
    spans.push(rec)
    const span: any = {
      setAttribute: (k: string, v: unknown) => (k === OBS_ATTR.outcome && (rec.outcome = v), span),
      addEvent: () => span,
      addLink: () => span,
      setStatus: () => span,
      recordException: () => span,
      end: () => {},
    }
    return fn(span)
  }) as never
  return { spans, restore: () => (TelemetryService.withSpan = orig) }
}

test.group('executeExtension observability (WS2)', (group) => {
  group.tap((t) => t.tags([AI_TAG]))
  let cap: ReturnType<typeof installCapture>
  group.each.setup(() => {
    cap = installCapture()
  })
  group.each.teardown(() => {
    cap.restore()
  })

  test('a clean run records outcome=completed on an extension.execute span', async ({ assert }) => {
    const out = await executeExtension(async () => 'ok', { label: 'x' })
    assert.equal(out, 'ok')
    assert.equal(cap.spans[0]!.name, OBS_SPAN.extensionExecute)
    assert.equal(cap.spans[0]!.outcome, EXTENSION_OUTCOME.completed)
  })

  test('a timeout records outcome=timeout', async ({ assert }) => {
    await assert.rejects(
      () =>
        executeExtension(() => delay(1000).then(() => 'late'), { label: 'slow', timeoutMs: 20 }),
      ExtensionTimeoutError
    )
    assert.equal(cap.spans[0]!.outcome, EXTENSION_OUTCOME.timeout)
  })

  test('a rate-limit rejection records outcome=rate_limited', async ({ assert }) => {
    await assert.rejects(() =>
      executeExtension(async () => 'ran', {
        label: 'rpt',
        rateLimit: { limit: 10, windowSeconds: 60 },
        getRedis: redisWith(new CountingPipeline(11)),
      })
    )
    assert.equal(cap.spans[0]!.outcome, EXTENSION_OUTCOME.rateLimited)
  })

  test('a rate-limit backend outage records outcome=rate_limit_unavailable', async ({ assert }) => {
    await assert.rejects(() =>
      executeExtension(async () => 'ran', {
        label: 'rpt',
        rateLimit: { limit: 10, windowSeconds: 60 },
        getRedis: redisWith(new FailingPipeline()),
      })
    )
    assert.equal(cap.spans[0]!.outcome, EXTENSION_OUTCOME.rateLimitUnavailable)
  })

  test('a thrown function records outcome=error', async ({ assert }) => {
    await assert.rejects(
      () =>
        executeExtension(
          async () => {
            throw new Error('boom')
          },
          { label: 'x' }
        ),
      /boom/
    )
    assert.equal(cap.spans[0]!.outcome, EXTENSION_OUTCOME.error)
  })
})
