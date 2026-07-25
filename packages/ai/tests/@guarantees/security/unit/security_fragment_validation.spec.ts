import { test } from '@japa/runner'
import type { StreamExtensionOptions } from '../../../../src/gateway/stream_extension.js'
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

test.group('StreamExtensionService: fragment validation', () => {
  test('a rejected fragment aborts and its bytes are never written', async ({ assert }) => {
    const { svc, quota } = service()
    const target = new FakeStreamTarget()
    const fragments: StreamFragment[] = [
      { data: 'safe', tokens: 1 },
      { data: 'SYSTEM PROMPT LEAK', tokens: 1 },
    ]
    // Reject any fragment that looks like a leak.
    const validateFragment = (f: StreamFragment) => (f.data.includes('LEAK') ? null : f)
    const result = await svc.stream(
      target,
      fragmentsProducer(fragments),
      opts({ validateFragment })
    )

    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') assert.equal(result.reason, 'fragment_rejected')
    assert.match(target.output, /data: safe/)
    assert.notMatch(target.output, /LEAK/) // the leaking bytes never reach the socket
    assert.equal(quota.releases, 1)
  })

  test('a negative token count is rejected as a leak', async ({ assert }) => {
    const { svc } = service()
    const target = new FakeStreamTarget()
    const result = await svc.stream(target, fragmentsProducer([{ data: 'x', tokens: -1 }]), opts())
    assert.equal(result.outcome, 'aborted')
    if (result.outcome === 'aborted') assert.equal(result.reason, 'fragment_rejected')
    assert.notMatch(target.output, /data: x/)
  })
})
