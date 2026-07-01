import { test } from '@japa/runner'
import type { StreamExtensionOptions } from '../../../../src/gateway/stream_extension.js'
import {
  FakeStreamTarget,
  fakeTenant,
  hookedProducer,
  makeService,
} from '../../../helpers/stream_doubles.js'
import { tick } from '../../../helpers/fake_sse_sink.js'
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

test.group('StreamExtensionService: streaming performance', () => {
  test('flushes the first fragment before the producer completes (incremental, not buffered)', async ({
    assert,
  }) => {
    const { svc } = makeService()
    const target = new FakeStreamTarget()
    let outputAtFirst = ''
    const producer = hookedProducer(
      [
        { data: 'first', tokens: 1 },
        { data: 'second', tokens: 1 },
      ],
      () => {
        outputAtFirst = target.output
      }
    )
    await svc.stream(target, producer, opts())
    assert.include(outputAtFirst, 'data: first')
    assert.notInclude(outputAtFirst, 'data: second')
  })

  test('backpressure throttles the producer pull instead of buffering unboundedly', async ({
    assert,
  }) => {
    const { svc } = makeService()
    const target = new FakeStreamTarget()
    target.sink.setBackpressure(true)

    let produced = 0
    const producer = async function* (): AsyncIterable<StreamFragment> {
      for (let i = 0; i < 5; i += 1) {
        produced += 1
        yield { data: `f${i}`, tokens: 1 }
      }
    }

    const done = svc.stream(target, producer, opts())
    await tick()
    assert.equal(produced, 1, 'only the first fragment is pulled; the rest wait behind drain')

    target.sink.setBackpressure(false)
    target.sink.emit('drain')
    await done
    assert.equal(produced, 5)
  })
})
