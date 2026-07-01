import { test } from '@japa/runner'
import type { StreamExtensionOptions } from '../../../../src/gateway/stream_extension.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  FakeStreamTarget,
  fakeTenant,
  fragmentsProducer,
  makeService as service,
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

test.group('StreamExtensionService: happy path', () => {
  test('a two-fragment stream completes, settles cumulative, releases once', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const fragments: StreamFragment[] = [
      { data: 'he', tokens: 2 },
      { data: 'llo', tokens: 3 },
    ]
    const result = await svc.stream(target, fragmentsProducer(fragments), opts())

    assert.deepEqual(result, {
      outcome: 'completed',
      tokensSettled: 5,
      fragments: 2,
      lastEventId: '2',
    })
    assert.isTrue(target.flushed)
    assert.equal(
      target.output,
      'id: 1\nevent: token\ndata: he\n\nid: 2\nevent: token\ndata: llo\n\n'
    )
    // settle-after-write: one settle per fragment with the running total, plus the finally settle.
    assert.deepEqual(quota.settles, [2, 5, 5])
    assert.equal(quota.releases, 1)
    assert.isTrue(target.disposedDisconnect)
  })

  test('a zero-fragment stream commits, completes with 0 tokens, releases the whole hold', async ({
    assert,
  }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const result = await svc.stream(target, fragmentsProducer([]), opts())
    assert.equal(result.outcome, 'completed')
    assert.isTrue(target.flushed)
    if (result.outcome === 'completed') assert.equal(result.tokensSettled, 0)
    assert.equal(quota.releases, 1)
  })

  test('honors the Last-Event-ID resume cursor in the flushed ids', async ({ assert }) => {
    const { svc } = service()
    const target = new FakeStreamTarget()
    const result = await svc.stream(
      target,
      fragmentsProducer([{ data: 'x', tokens: 1 }]),
      opts({ lastEventId: '41' })
    )
    assert.match(target.output, /id: 42/)
    if (result.outcome === 'completed') assert.equal(result.lastEventId, '42')
  })
})

test.group('StreamExtensionService: budget early-stop', () => {
  test('trips aborted:budget once reported tokens reach the worst case', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const fragments: StreamFragment[] = [
      { data: 'a', tokens: 2 },
      { data: 'b', tokens: 2 },
      { data: 'c', tokens: 2 },
    ]
    const result = await svc.stream(target, fragmentsProducer(fragments), opts({ worstCase: 3 }))
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') {
      assert.equal(result.reason, 'budget')
      assert.equal(result.fragments, 2) // stopped after the fragment that reached the cap
    }
    assert.equal(quota.releases, 1)
  })
})

test.group('StreamExtensionService: mid-stream provider error', () => {
  test('writes a code-only in-band error frame, settles used, never throws', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const producer = async function* () {
      yield { data: 'hi', tokens: 1 } as StreamFragment
      throw new AIException('provider_unavailable', 'upstream 503 with a secret body')
    }
    const result = await svc.stream(target, producer, opts())
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') assert.equal(result.reason, 'provider_error')
    assert.match(target.output, /event: error\ndata: provider_unavailable/)
    assert.notMatch(target.output, /secret body/) // never the upstream body
    assert.equal(quota.releases, 1)
  })
})
