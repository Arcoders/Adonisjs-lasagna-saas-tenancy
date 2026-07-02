import { test } from '@japa/runner'
// The I4 guard is a repo-root script (it runs in `npm run check`); import its
// pure auditor to exercise the rule that the satellite never AUTHORS a
// system-role message (host system prompts pass through as data; retrieved
// content is fenced in a user turn by buildRetrievalContext).
import { auditSystemPromptPurity } from '../../../../../scripts/check-ai-invariant-4.mjs'

test.group('architectural — I4 system-prompt purity guard', () => {
  test('a user-role retrieved-context message passes', ({ assert }) => {
    const problems = auditSystemPromptPurity([
      { path: 'src/gateway/context_builder.ts', source: "return { role: 'user', content }" },
    ])
    assert.deepEqual(problems, [])
  })

  test('the role TYPE union is not flagged (it is not a constructed message)', ({ assert }) => {
    const problems = auditSystemPromptPurity([
      {
        path: 'src/types/ai_provider_contract.ts',
        source: "readonly role: 'system' | 'user' | 'assistant'",
      },
    ])
    assert.deepEqual(problems, [])
  })

  test('a parse-time allow-list is not flagged', ({ assert }) => {
    const problems = auditSystemPromptPurity([
      { path: 'src/x.ts', source: "const ROLES = new Set(['system', 'user', 'assistant'])" },
    ])
    assert.deepEqual(problems, [])
  })

  test('a satellite-authored { role: "system", content } message is an I4 violation', ({
    assert,
  }) => {
    const problems = auditSystemPromptPurity([
      { path: 'src/x.ts', source: "messages.push({ role: 'system', content: retrieved })" },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /must not author a system-role message/)
  })

  test('a system role as the last property (role last) is still flagged', ({ assert }) => {
    const problems = auditSystemPromptPurity([
      { path: 'src/x.ts', source: 'const m = { content: x, role: "system" }' },
    ])
    assert.lengthOf(problems, 1)
  })

  test('a comment mentioning role: "system" is not flagged', ({ assert }) => {
    const problems = auditSystemPromptPurity([
      { path: 'src/x.ts', source: "// never construct role: 'system' from tenant data" },
    ])
    assert.deepEqual(problems, [])
  })
})
