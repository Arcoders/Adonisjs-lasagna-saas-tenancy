import { test } from '@japa/runner'
import AIProviderRegistry from '../../../../src/services/ai_provider_registry.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { checkAIProviderConformance } from '../../../../src/testing/conformance.js'

test.group('AIProviderRegistry: map operations', () => {
  test('the first registered provider becomes active; activate switches it', ({ assert }) => {
    const registry = new AIProviderRegistry()
    const a = new MockAIProvider({ name: 'a' })
    const b = new MockAIProvider({ name: 'b' })
    registry.register(a)
    registry.register(b, { activate: true })
    assert.strictEqual(registry.active(), b)
    registry.use('a')
    assert.strictEqual(registry.active(), a)
  })

  test('active() throws with no providers; use() throws for an unknown name', ({ assert }) => {
    const registry = new AIProviderRegistry()
    assert.throws(() => registry.active(), /no active provider/)
    assert.throws(() => registry.use('nope'), /is not registered/)
  })

  test('get / has / list / clear', ({ assert }) => {
    const registry = new AIProviderRegistry()
    registry.register(new MockAIProvider({ name: 'claude' }))
    registry.register(new MockAIProvider({ name: 'deepseek' }))
    assert.isTrue(registry.has('claude'))
    assert.isUndefined(registry.get('kimi'))
    assert.deepEqual([...registry.list()], ['claude', 'deepseek'])
    registry.clear()
    assert.deepEqual([...registry.list()], [])
    assert.throws(() => registry.active(), /no active provider/)
  })
})

test.group('checkAIProviderConformance', () => {
  test('a well-formed provider has no problems', ({ assert }) => {
    assert.deepEqual(checkAIProviderConformance(new MockAIProvider()), [])
  })

  test('a non-streaming provider is flagged', ({ assert }) => {
    const problems = checkAIProviderConformance(new MockAIProvider({ streaming: false }))
    assert.isAbove(problems.length, 0)
    assert.match(problems.join(' '), /streaming must be true/)
  })

  test('a malformed provider is flagged on every missing piece', ({ assert }) => {
    const broken = { name: '', capabilities: { streaming: false } } as never
    const problems = checkAIProviderConformance(broken)
    const joined = problems.join(' ')
    assert.match(joined, /name must be a non-empty string/)
    assert.match(joined, /streaming must be true/)
    assert.match(joined, /verifyConfig must be a function/)
    assert.match(joined, /stream must be a function/)
  })
})
