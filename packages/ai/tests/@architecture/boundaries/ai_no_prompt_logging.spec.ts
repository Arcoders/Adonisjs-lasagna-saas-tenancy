import { test } from '@japa/runner'
// The #15 (no-train) guard is a repo-root script (it runs in `npm run check`);
// import its pure auditor to exercise the rules that keep prompts / responses /
// documents / memory out of application logs.
import { auditNoPromptLogging } from '../../../../../scripts/check-ai-no-prompt-logging-for-training.mjs'

const FILE = 'packages/ai/src/gateway/ai_chat_controller.ts'

test.group('architectural — #15 no-prompt-logging (no-train) guard', () => {
  test('a metadata-only log passes', ({ assert }) => {
    const clean = [
      'this.#deps.warn?.(`[ai] conversation memory persist failed for a session (store error)`)',
      'logger.info(`[ai] retrieved ${matchCount} matches for the query`)',
      "invalid('query must be a non-empty string')",
    ].join('\n')
    assert.deepEqual(auditNoPromptLogging([{ path: FILE, source: clean }]), [])
  })

  test('logging a prompt via a template interpolation is a violation', ({ assert }) => {
    const bad = 'logger.warn(`chat failed for prompt: ${prompt}`)'
    const problems = auditNoPromptLogging([{ path: FILE, source: bad }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /content/)
  })

  test('logging the retrieved document content is a violation', ({ assert }) => {
    const bad = 'this.#deps.warn?.(`retrieved: ${match.content}`)'
    const problems = auditNoPromptLogging([{ path: FILE, source: bad }])
    assert.lengthOf(problems, 1)
  })

  test('a raw console call is a violation regardless of content', ({ assert }) => {
    const problems = auditNoPromptLogging([{ path: FILE, source: 'console.log("hi")' }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /console/)
  })

  test('a comment mentioning a prompt is ignored', ({ assert }) => {
    const problems = auditNoPromptLogging([
      { path: FILE, source: '// logger.warn(`${prompt}`) would leak; we never do this' },
    ])
    assert.deepEqual(problems, [])
  })
})
