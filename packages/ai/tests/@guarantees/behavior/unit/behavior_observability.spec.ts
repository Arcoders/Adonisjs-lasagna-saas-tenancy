import { test } from '@japa/runner'
import type { StreamExtensionOptions } from '../../../../src/gateway/stream_extension.js'
import {
  FakeStreamTarget,
  fakeTenant,
  fragmentsProducer,
  hookedProducer,
  makeObservableService,
} from '../../../helpers/stream_doubles.js'

function opts(overrides: Partial<StreamExtensionOptions> = {}): StreamExtensionOptions {
  return {
    label: 'ai.stream',
    tenant: fakeTenant,
    quota: 'ai',
    worstCase: 100,
    validateFragment: (f) => f,
    provider: 'claude',
    model: 'claude-opus-4-8',
    ...overrides,
  }
}

const SPAN_ATTR_ALLOWLIST = new Set(['tenant.id', 'provider', 'model'])

test.group('StreamExtensionService: observability', () => {
  test('wraps the call in an ai.stream span with an allow-listed attribute set', async ({
    assert,
  }) => {
    const { svc, capture } = makeObservableService()
    await svc.stream(new FakeStreamTarget(), fragmentsProducer([{ data: 'hi', tokens: 3 }]), opts())
    assert.lengthOf(capture.spans, 1)
    assert.equal(capture.spans[0].name, 'ai.stream')
    assert.deepEqual(capture.spans[0].attrs, {
      'tenant.id': 't1',
      'provider': 'claude',
      'model': 'claude-opus-4-8',
    })
    // No attribute key is anything but the allow-list (no prompt/response content).
    for (const key of Object.keys(capture.spans[0].attrs))
      assert.isTrue(SPAN_ATTR_ALLOWLIST.has(key))
  })

  test('emits integer request + token metrics on completion', async ({ assert }) => {
    const { svc, capture } = makeObservableService()
    await svc.stream(
      new FakeStreamTarget(),
      fragmentsProducer([
        { data: 'a', tokens: 2 },
        { data: 'b', tokens: 5 },
      ]),
      opts()
    )
    const byName = Object.fromEntries(capture.metrics.map((m) => [m.name, m.value]))
    assert.equal(byName['ai_requests'], 1)
    assert.equal(byName['ai_tokens_total'], 7)
    assert.isUndefined(byName['ai_errors'])
    // Every metric value is an integer (never a float / cost / content).
    for (const m of capture.metrics)
      assert.isTrue(Number.isInteger(m.value), `${m.name} is integer`)
  })

  test('emits ai_errors and ai_stream_disconnects on a client disconnect', async ({ assert }) => {
    const { svc, capture } = makeObservableService()
    const target = new FakeStreamTarget()
    const producer = hookedProducer([{ data: 'a', tokens: 1 }], () => target.abortDisconnect())
    await svc.stream(target, producer, opts())
    const names = capture.metrics.map((m) => m.name)
    assert.include(names, 'ai_errors')
    assert.include(names, 'ai_stream_disconnects')
  })

  test('never records content in a metric value or a span attribute', async ({ assert }) => {
    const { svc, capture } = makeObservableService()
    const secret = 'PROMPT-CONTENT-should-never-appear'
    await svc.stream(
      new FakeStreamTarget(),
      fragmentsProducer([{ data: secret, tokens: 1 }]),
      opts()
    )
    const serialized = JSON.stringify(capture)
    assert.notInclude(serialized, secret)
  })
})
