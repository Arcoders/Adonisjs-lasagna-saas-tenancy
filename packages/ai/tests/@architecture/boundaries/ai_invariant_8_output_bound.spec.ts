import { test } from '@japa/runner'
// The I8 guard is a repo-root script (it runs in `npm run check`); import its
// pure auditor to exercise the rule that every streaming-spine invocation wires a
// validateFragment output bound (the bytes of a leaking / over-cap fragment never
// reach the socket).
import { auditOutputBounds } from '../../../../../scripts/check-ai-invariant-8.mjs'

test.group('architectural: I8 output-bound guard', () => {
  test('a spine call that wires validateFragment passes', ({ assert }) => {
    const problems = auditOutputBounds([
      {
        path: 'src/gateway/ai_chat_controller.ts',
        source:
          'await this.deps.stream.stream(\n  target,\n  producer,\n  { label: "ai:chat", validateFragment: boundedFragmentGate }\n)',
      },
    ])
    assert.deepEqual(problems, [])
  })

  test('a spine call with NO validateFragment is an I8 violation', ({ assert }) => {
    const problems = auditOutputBounds([
      {
        path: 'src/x.ts',
        source: 'await this.deps.stream.stream(\n  target,\n  producer,\n  { label: "ai:chat" }\n)',
      },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /no validateFragment output bound/)
  })

  test('the raw provider.stream producer is not the spine (not flagged)', ({ assert }) => {
    const problems = auditOutputBounds([
      { path: 'src/x.ts', source: '(signal) => provider.stream(request, signal)' },
    ])
    assert.deepEqual(problems, [])
  })

  test('a comment naming .stream.stream is not flagged', ({ assert }) => {
    const problems = auditOutputBounds([
      { path: 'src/x.ts', source: '// the spine is invoked as x.stream.stream(target, ...)' },
    ])
    assert.deepEqual(problems, [])
  })
})
