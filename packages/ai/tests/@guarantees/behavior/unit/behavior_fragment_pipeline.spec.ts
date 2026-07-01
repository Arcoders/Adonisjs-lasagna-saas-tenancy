import { test } from '@japa/runner'
import FragmentPipeline from '../../../../src/gateway/fragment_pipeline.js'
import type { StreamFragment } from '../../../../src/types/ai_provider_contract.js'

const passthrough = (f: StreamFragment) => f

test.group('FragmentPipeline', () => {
  test('admits a valid fragment and accounts its tokens', ({ assert }) => {
    const pipeline = new FragmentPipeline(passthrough, 100)
    const fragment = { data: 'x', tokens: 3 } as StreamFragment
    assert.strictEqual(pipeline.admit(fragment), fragment)
    pipeline.account(fragment)
    assert.equal(pipeline.cumulative, 3)
    assert.equal(pipeline.count, 1)
  })

  test('rejects a fragment the validator nulls out', ({ assert }) => {
    const pipeline = new FragmentPipeline(() => null, 100)
    assert.isNull(pipeline.admit({ data: 'leak', tokens: 1 }))
  })

  test('rejects a negative or non-finite token count', ({ assert }) => {
    const pipeline = new FragmentPipeline(passthrough, 100)
    assert.isNull(pipeline.admit({ data: 'x', tokens: -1 }))
    assert.isNull(pipeline.admit({ data: 'x', tokens: Number.NaN }))
  })

  test('budgetExhausted trips once cumulative reaches the worst case', ({ assert }) => {
    const pipeline = new FragmentPipeline(passthrough, 3)
    pipeline.account({ data: 'a', tokens: 2 })
    assert.isFalse(pipeline.budgetExhausted)
    pipeline.account({ data: 'b', tokens: 2 })
    assert.isTrue(pipeline.budgetExhausted)
    assert.equal(pipeline.cumulative, 4)
  })
})
