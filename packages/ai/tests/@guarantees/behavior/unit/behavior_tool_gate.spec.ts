import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  advertisedTools,
  authorizeToolScope,
  isToolScope,
  resolveToolRegistry,
} from '../../../../src/gateway/tool_gate.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../../src/define_config.js'

const tenant = { id: 't1' } as unknown as TenantModelContract
const ctx = {} as unknown as HttpContext

function tool(name: string, mode?: 'read' | 'action'): AIToolHostDefinition {
  return {
    name,
    description: name,
    inputSchema: {},
    handler: async () => ({}),
    ...(mode ? { mode } : {}),
  }
}

test.group('tool_gate — resolveToolRegistry (default-deny)', () => {
  test('no tools config yields no tools', async ({ assert }) => {
    assert.deepEqual(await resolveToolRegistry(ctx, tenant, undefined), [])
    assert.deepEqual(await resolveToolRegistry(ctx, tenant, {}), [])
  })

  test('registry + resolveTools combine first-wins by name, malformed dropped', async ({
    assert,
  }) => {
    const result = await resolveToolRegistry(ctx, tenant, {
      registry: [tool('a'), { name: '' } as unknown as AIToolHostDefinition, tool('b')],
      resolveTools: async () => [tool('b'), tool('c')],
    })
    assert.deepEqual(
      result.map((t) => t.name),
      ['a', 'b', 'c']
    )
  })

  test('a throwing resolveTools denies with a typed refusal, never a 500', async ({ assert }) => {
    // The host resolver IS the per-tenant policy decision. One that cannot decide
    // must not degrade to "no tools" (an ungrounded answer as though tool calling
    // were unavailable) nor escape untyped to the framework's 500 renderer.
    let error: unknown
    try {
      await resolveToolRegistry(ctx, tenant, {
        registry: [tool('a')],
        resolveTools: async () => {
          throw new Error('the tenant tool policy backend is down')
        },
      })
    } catch (caught) {
      error = caught
    }
    assert.instanceOf(error, AIException)
    assert.equal((error as AIException).aiCode, 'tool_denied')
    assert.equal((error as AIException).httpStatus, 403)
    assert.notMatch((error as AIException).message, /policy backend/i, 'no internals leak')
  })
})

test.group('tool_gate — advertisedTools', () => {
  test('filters action tools and strips to the wire shape', ({ assert }) => {
    const adv = advertisedTools([tool('read1'), tool('write', 'action'), tool('read2')])
    assert.deepEqual(
      adv.map((t) => t.name),
      ['read1', 'read2']
    )
    assert.notProperty(adv[0], 'handler')
    assert.notProperty(adv[0], 'mode')
  })

  test('caps at MAX_TOOL_DEFS (64)', ({ assert }) => {
    const many = Array.from({ length: 100 }, (_, i) => tool(`t${i}`))
    assert.lengthOf(advertisedTools(many), 64)
  })
})

test.group('tool_gate — isToolScope', () => {
  test('validates the discriminated union, fail-closed on junk', ({ assert }) => {
    assert.isTrue(isToolScope({ kind: 'allow' }))
    assert.isTrue(isToolScope({ kind: 'allow', filter: { status: 'active' } }))
    assert.isTrue(isToolScope({ kind: 'deny' }))
    assert.isFalse(isToolScope({ kind: 'maybe' }))
    assert.isFalse(isToolScope({ kind: 'allow', filter: [] }))
    assert.isFalse(isToolScope({ kind: 'allow', filter: null }))
    assert.isFalse(isToolScope(null))
    assert.isFalse(isToolScope('allow'))
  })
})

test.group('tool_gate — authorizeToolScope (fail-closed)', () => {
  test('absent hook denies unless acknowledged', async ({ assert }) => {
    await assert.rejects(() => authorizeToolScope(ctx, tenant, 'read', {}), /not authorized/)
    assert.deepEqual(
      await authorizeToolScope(ctx, tenant, 'read', { acknowledgeUnauthorizedTools: true }),
      { kind: 'allow' }
    )
  })

  test('allow passes the filter through; deny, throw and invalid all reject', async ({
    assert,
  }) => {
    assert.deepEqual(
      await authorizeToolScope(ctx, tenant, 'read', {
        authorizeTool: () => ({ kind: 'allow', filter: { s: 1 } }),
      }),
      { kind: 'allow', filter: { s: 1 } }
    )
    await assert.rejects(
      () => authorizeToolScope(ctx, tenant, 'read', { authorizeTool: () => ({ kind: 'deny' }) }),
      /not authorized/
    )
    await assert.rejects(
      () =>
        authorizeToolScope(ctx, tenant, 'read', {
          authorizeTool: () => {
            throw new Error('acl down')
          },
        }),
      /not authorized/
    )
    await assert.rejects(
      () =>
        authorizeToolScope(ctx, tenant, 'read', {
          authorizeTool: () =>
            ({ bad: true }) as unknown as ReturnType<NonNullable<AIToolsConfig['authorizeTool']>>,
        }),
      /not authorized/
    )
  })

  test('a deny is a 403 tool_denied', async ({ assert }) => {
    let err: unknown
    try {
      await authorizeToolScope(ctx, tenant, 'read', { authorizeTool: () => ({ kind: 'deny' }) })
    } catch (e) {
      err = e
    }
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_denied')
    assert.equal((err as AIException).httpStatus, 403)
  })
})
