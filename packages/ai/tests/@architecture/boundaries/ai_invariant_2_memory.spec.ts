import { test } from '@japa/runner'
// The I2 guard is a repo-root script (it runs in `npm run check`); import its
// pure auditor to exercise the rules that keep conversation memory encrypted at
// rest, session-bound by HMAC, and replayed as user/assistant DATA (never system).
import { auditMemoryInvariant } from '../../../../../scripts/check-ai-invariant-2.mjs'

const SERVICE = 'packages/ai/src/services/conversation_memory_service.ts'
const CONTEXT = 'packages/ai/src/gateway/context_builder.ts'

/** A minimal service source that satisfies the crypto rules (encrypt + timingSafeEqual). */
const cleanService = [
  'const cipher = this.#deps.encryptMemory(JSON.stringify(x))',
  'if (!timingSafeEqual(a, b)) throw new Error("no")',
  "turns.push({ role: 'user', content: u })",
  "turns.push({ role: 'assistant', content: a })",
].join('\n')

test.group('architectural — I2 conversation memory guard', () => {
  test('a clean memory service (encrypt + HMAC + data roles) passes', ({ assert }) => {
    const problems = auditMemoryInvariant([{ path: SERVICE, source: cleanService }])
    assert.deepEqual(problems, [])
  })

  test('constructing a system-role memory turn is an I2 violation', ({ assert }) => {
    const problems = auditMemoryInvariant([
      { path: CONTEXT, source: "const turn = { role: 'system', content: memory }" },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /role:'system'/)
  })

  test('a memory service that never encrypts is an I2 violation', ({ assert }) => {
    const problems = auditMemoryInvariant([
      {
        path: SERVICE,
        source: 'await redis.rpush(key, JSON.stringify(x))\nif (!timingSafeEqual(a, b)) throw e',
      },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /encrypt via encryptMemory/)
  })

  test('a memory service that never HMAC-validates a session is an I2 violation', ({ assert }) => {
    const problems = auditMemoryInvariant([
      { path: SERVICE, source: 'const cipher = this.#deps.encryptMemory(x)\nif (a === b) throw e' },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /timingSafeEqual/)
  })

  test('a `role === "system"` comparison (not a construction) is not flagged', ({ assert }) => {
    const problems = auditMemoryInvariant([
      { path: CONTEXT, source: "while (messages[count].role === 'system') count += 1" },
    ])
    assert.deepEqual(problems, [])
  })

  test('a comment naming role: system is not flagged', ({ assert }) => {
    const problems = auditMemoryInvariant([
      { path: CONTEXT, source: "// never construct role: 'system' for a memory turn" },
    ])
    assert.deepEqual(problems, [])
  })

  test('the real committed memory files pass the guard', async ({ assert }) => {
    // Drive the auditor against the real sources so the invariant is pinned to the
    // shipped code, not only synthetic inputs. Read via fs (the spec is unit-tier).
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../../../../../', import.meta.url))
    const files = [SERVICE, CONTEXT].map((rel) => ({
      path: rel,
      source: readFileSync(root + rel, 'utf8'),
    }))
    assert.deepEqual(auditMemoryInvariant(files), [])
  })
})
