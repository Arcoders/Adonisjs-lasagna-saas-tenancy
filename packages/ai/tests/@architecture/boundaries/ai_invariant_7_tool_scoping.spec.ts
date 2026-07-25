import { test } from '@japa/runner'
// The I7 guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the rule that a tool handler runs inside `tenancy.run(tenant)`,
// with the ambient scope re-asserted BEFORE the bind, behind a default-deny registry
// and a per-call authorization.
import { auditToolScoping } from '../../../../../scripts/check-ai-invariant-7.mjs'

const EXECUTOR = 'packages/ai/src/services/tool_executor.ts'
const GATE = 'packages/ai/src/gateway/tool_gate.ts'

/** A minimal executor source holding I7 correctly: assert, THEN bind. */
const goodExecutor = `
  const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
  assertActiveToolScope(this.deps.activeScopeTenantId(), tenant.id)
  result = await this.deps.runScoped(tenant, async () => t.handler(args, context))
`

const goodGate = `
export async function resolveToolRegistry(ctx, tenant, toolsConfig) {
  if (!toolsConfig) return []
  return out
}
`

const ok = (executor = goodExecutor, gate = goodGate) =>
  auditToolScoping([
    { path: EXECUTOR, source: executor },
    { path: GATE, source: gate },
  ])

test.group('architectural: I7 tool-scoping guard', () => {
  test('the real shape passes', ({ assert }) => {
    assert.deepEqual(ok(), [])
  })

  test('a handler awaited outside runScoped is an I7 violation', ({ assert }) => {
    const problems = ok(`
      const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
      assertActiveToolScope(this.deps.activeScopeTenantId(), tenant.id)
      result = await t.handler(args, context)
    `)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /MUST run inside the active tenancy scope/)
  })

  test('the re-assert INSIDE the bind is caught as the tautology it is', ({ assert }) => {
    // This is the headline case, and the reason the guard checks ORDER rather than
    // presence: reading the active scope after runScoped binds it compares the
    // just-set scope to itself, so the check passes forever while checking nothing.
    // A presence-only scan would happily green-light this.
    const problems = ok(`
      const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
      result = await this.deps.runScoped(tenant, async () => {
        assertActiveToolScope(this.deps.activeScopeTenantId(), tenant.id)
        return t.handler(args, context)
      })
    `)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /must be called BEFORE runScoped/)
    assert.match(problems[0]!, /tautology/)
  })

  test('a deleted re-assert is an I7 violation', ({ assert }) => {
    const problems = ok(`
      const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
      result = await this.deps.runScoped(tenant, async () => t.handler(args, context))
    `)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /no assertActiveToolScope/)
  })

  test('a dropped per-call authorization is an I7 violation', ({ assert }) => {
    const problems = ok(`
      assertActiveToolScope(this.deps.activeScopeTenantId(), tenant.id)
      result = await this.deps.runScoped(tenant, async () => t.handler(args, context))
    `)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /authorized per call/)
  })

  test('a registry that falls back instead of denying is an I7 violation', ({ assert }) => {
    const problems = ok(
      goodExecutor,
      `
export async function resolveToolRegistry(ctx, tenant, toolsConfig) {
  return toolsConfig ? out : AMBIENT_TOOLS
}
`
    )
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /must return \[\] when config\.ai\.tools is absent/)
  })

  test('a comment describing the rule does not satisfy it', ({ assert }) => {
    // The guard must read code, not prose: a file that only TALKS about calling
    // assertActiveToolScope before runScoped is not enforcing anything.
    const problems = ok(`
      // assertActiveToolScope(active, tenant.id) is called before runScoped binds.
      const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
      result = await this.deps.runScoped(tenant, async () => t.handler(args, context))
    `)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /no assertActiveToolScope/)
  })

  test('a moved executor fails loudly rather than silently passing', ({ assert }) => {
    // If the file is renamed, the guard must go red so someone updates it. A scan
    // that finds nothing and reports OK is worse than no scan at all.
    const problems = auditToolScoping([{ path: GATE, source: goodGate }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /missing/)
  })
})
