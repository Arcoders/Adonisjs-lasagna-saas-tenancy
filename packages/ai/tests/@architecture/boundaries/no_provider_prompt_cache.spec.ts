import { test } from '@japa/runner'
// H2 anti-drift guard: the provider request builders must never emit a
// provider prompt-cache directive that is not tenant-namespaced. Exercise the pure
// auditor that the repo-root `npm run check` runs against the real model-provider files.
import { auditNoProviderPromptCache } from '../../../../../scripts/check-ai-no-provider-prompt-cache.mjs'

const FILE = 'packages/ai/src/providers/claude_provider.ts'

test.group('architectural: H2 no provider prompt-cache', () => {
  test('a plain request body with no cache directive passes', ({ assert }) => {
    const clean = [
      'return { model: this.deps.model, max_tokens: max, messages, stream: true }',
      'const headers = { authorization: `Bearer ${this.deps.apiKey}` }',
    ].join('\n')
    assert.deepEqual(auditNoProviderPromptCache([{ path: FILE, source: clean }]), [])
  })

  test('an Anthropic cache_control directive is a violation', ({ assert }) => {
    const bad = 'messages: [{ role: "user", content, cache_control: { type: "ephemeral" } }]'
    const problems = auditNoProviderPromptCache([{ path: FILE, source: bad }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /cache_control/)
  })

  test('an OpenAI prompt_cache_key directive is a violation', ({ assert }) => {
    const bad = 'body.prompt_cache_key = fingerprint'
    const problems = auditNoProviderPromptCache([{ path: FILE, source: bad }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /prompt_cache_key/)
  })

  test('a comment mentioning cache_control is ignored', ({ assert }) => {
    const problems = auditNoProviderPromptCache([
      {
        path: FILE,
        source: '// we never send cache_control; an un-salted cache would leak across tenants',
      },
    ])
    assert.deepEqual(problems, [])
  })
})
