import { test } from '@japa/runner'
import type { StreamExtensionOptions } from '../../../../src/gateway/stream_extension.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  FakeQuota,
  FakeStreamTarget,
  codedError,
  fakeTenant,
  fragmentsProducer,
  hookedProducer,
  makeService as service,
  sleep,
} from '../../../helpers/stream_doubles.js'
import type { StreamFragment } from '../../../../src/types/ai_provider_contract.js'

function opts(overrides: Partial<StreamExtensionOptions> = {}): StreamExtensionOptions {
  return {
    label: 'ai.stream',
    tenant: fakeTenant,
    quota: 'ai',
    worstCase: 100,
    validateFragment: (f) => f,
    ...overrides,
  }
}

test.group('StreamExtensionService: pre-flight failures (no bytes)', () => {
  test('open breaker -> failed_preflight provider_unavailable, headers not flushed', async ({
    assert,
  }) => {
    const { svc, breaker } = service()
    breaker.open = true
    const target = new FakeStreamTarget()
    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: 1 }]), opts())
    assert.deepEqual(result, { outcome: 'failed_preflight', error: 'provider_unavailable' })
    assert.isFalse(target.flushed)
    assert.equal(target.output, '')
  })

  test('reserve over-budget -> failed_preflight over_budget', async ({ assert }) => {
    const quota = new FakeQuota()
    quota.reserveError = codedError('E_TENANT_QUOTA_EXCEEDED')
    const { svc } = service(quota)
    const result = await svc.stream(new FakeStreamTarget(), fragmentsProducer([]), opts())
    assert.deepEqual(result, { outcome: 'failed_preflight', error: 'over_budget' })
  })

  test('reserve on a Redis outage -> failed_preflight rate_limit_unavailable', async ({
    assert,
  }) => {
    const quota = new FakeQuota()
    quota.reserveError = codedError('E_DEPENDENCY_UNAVAILABLE')
    const { svc } = service(quota)
    const result = await svc.stream(new FakeStreamTarget(), fragmentsProducer([]), opts())
    assert.deepEqual(result, { outcome: 'failed_preflight', error: 'rate_limit_unavailable' })
  })

  test('a provider 429 before the first byte -> failed_preflight rate_limited', async ({
    assert,
  }) => {
    const { svc } = service()
    const producer = async function* (): AsyncIterable<StreamFragment> {
      throw new AIException('rate_limited', 'provider 429')
    }
    const target = new FakeStreamTarget()
    const result = await svc.stream(target, producer, opts())
    assert.deepEqual(result, { outcome: 'failed_preflight', error: 'rate_limited' })
    assert.isFalse(target.flushed)
  })

  test('a provider 5xx before the first byte -> failed_preflight provider_unavailable', async ({
    assert,
  }) => {
    const { svc } = service()
    const producer = async function* (): AsyncIterable<StreamFragment> {
      throw new AIException('provider_unavailable', 'provider 503')
    }
    const result = await svc.stream(new FakeStreamTarget(), producer, opts())
    assert.deepEqual(result, { outcome: 'failed_preflight', error: 'provider_unavailable' })
  })

  test('a fatal producer refusal keeps its own code, not a retryable provider_unavailable', async ({
    assert,
  }) => {
    // A model outside the allow-list (403) and a BYOK-endpoint block (400) are
    // fatal: the classifier must preserve the code so the gateway maps the real
    // status, never collapsing a permanent denial to a retryable 503.
    for (const code of ['provider_not_allowed', 'byok_endpoint_blocked'] as const) {
      const { svc } = service()
      const producer = async function* (): AsyncIterable<StreamFragment> {
        throw new AIException(code, `refusing: ${code}`)
      }
      const target = new FakeStreamTarget()
      const result = await svc.stream(target, producer, opts())
      assert.deepEqual(result, { outcome: 'failed_preflight', error: code })
      assert.isFalse(target.flushed, 'a pre-commit refusal leaves headers unsent')
    }
  })
})

test.group('StreamExtensionService: mid-stream aborts', () => {
  test('a liveness abort -> aborted tenant_suspended', async ({ assert }) => {
    const { svc } = service()
    const target = new FakeStreamTarget()
    const liveness = new AbortController()
    const producer = hookedProducer(
      [
        { data: 'a', tokens: 1 },
        { data: 'b', tokens: 1 },
      ],
      () => liveness.abort()
    )
    const result = await svc.stream(target, producer, opts({ livenessSignal: liveness.signal }))
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') {
      assert.equal(result.reason, 'tenant_suspended')
      assert.equal(result.fragments, 1)
    }
  })

  test('a client disconnect -> aborted client_disconnect, reservation settled-for-used', async ({
    assert,
  }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const producer = hookedProducer(
      [
        { data: 'a', tokens: 4 },
        { data: 'b', tokens: 4 },
      ],
      () => target.abortDisconnect()
    )
    const result = await svc.stream(target, producer, opts())
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') {
      assert.equal(result.reason, 'client_disconnect')
      assert.equal(result.tokensSettled, 4)
    }
    assert.equal(quota.releases, 1)
  })

  test('a response timeout -> aborted timeout', async ({ assert }) => {
    const { svc } = service()
    const producer = async function* () {
      yield { data: 'first', tokens: 1 } as StreamFragment
      await sleep(50) // exceeds timeoutMs below
      yield { data: 'never', tokens: 1 } as StreamFragment
    }
    const result = await svc.stream(new FakeStreamTarget(), producer, opts({ timeoutMs: 5 }))
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') assert.equal(result.reason, 'timeout')
  })

  test('a socket write error -> aborted client_disconnect', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    // The sink errors on the first write attempt.
    const originalWrite = target.sink.write.bind(target.sink)
    let wrote = false
    target.sink.write = (chunk: string) => {
      if (!wrote) {
        wrote = true
        throw new Error('EPIPE')
      }
      return originalWrite(chunk)
    }
    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: 1 }]), opts())
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') assert.equal(result.reason, 'client_disconnect')
    assert.equal(quota.releases, 1)
  })
})

test.group('StreamExtensionService: fail-open finally', () => {
  test('a Redis blip on settle + release in the finally never breaks the stream', async ({
    assert,
  }) => {
    const quota = new FakeQuota()
    quota.settleError = codedError('E_DEPENDENCY_UNAVAILABLE')
    quota.releaseError = codedError('E_DEPENDENCY_UNAVAILABLE')
    const { svc } = service(quota)
    const target = new FakeStreamTarget()
    // The whole call must resolve completed with no throw escaping the finally.
    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: 1 }]), opts())
    assert.equal(result.outcome, 'completed')
    assert.isTrue(target.flushed)
  })

  test('release runs exactly once even on an abort', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const producer = hookedProducer([{ data: 'a', tokens: 1 }], () => target.abortDisconnect())
    await svc.stream(target, producer, opts())
    assert.equal(quota.releases, 1)
  })
})
