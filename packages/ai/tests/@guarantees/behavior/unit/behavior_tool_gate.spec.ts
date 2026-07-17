import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  advertisedTools,
  assertActionAllowed,
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

/** A well-formed action tool: mutating, and carrying the summary a human would read. */
function actionTool(name: string): AIToolHostDefinition {
  return { ...tool(name, 'action'), summarizeArgs: () => `do ${name}` }
}

/** Action tools switched on, the only config under which a write can ever run. */
const ACTIONS_ON: AIToolsConfig = { actionTools: { enabled: true } }

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
  test('with the kill-switch off, an action tool is never named to the model', ({ assert }) => {
    // Not merely refused later: unadvertised, so the model cannot propose it and no
    // human is ever shown a confirmation for a write the operator disabled.
    const adv = advertisedTools([tool('read1'), actionTool('write'), tool('read2')], {})
    assert.deepEqual(
      adv.map((t) => t.name),
      ['read1', 'read2']
    )
    assert.notProperty(adv[0], 'handler')
    assert.notProperty(adv[0], 'mode')
  })

  test('with it on, action tools are advertised alongside read tools', ({ assert }) => {
    const adv = advertisedTools([tool('read1'), actionTool('write')], ACTIONS_ON)
    assert.deepEqual(
      adv.map((t) => t.name),
      ['read1', 'write']
    )
    // The wire shape carries no handler and no summarizer: the model is told what
    // the tool takes, never how the host runs it or describes it to a person.
    assert.notProperty(adv[1], 'handler')
    assert.notProperty(adv[1], 'summarizeArgs')
  })

  test('an action tool with no summarizeArgs stays unadvertised even when enabled', ({
    assert,
  }) => {
    // It could never execute, so advertising it would only produce a refusal the
    // model would then narrate to the user as a failure.
    const adv = advertisedTools([tool('read1'), tool('write', 'action')], ACTIONS_ON)
    assert.deepEqual(
      adv.map((t) => t.name),
      ['read1']
    )
  })

  test('caps at MAX_TOOL_DEFS (64)', ({ assert }) => {
    const many = Array.from({ length: 100 }, (_, i) => tool(`t${i}`))
    assert.lengthOf(advertisedTools(many, {}), 64)
  })
})

test.group('tool_gate — assertActionAllowed (the kill-switch)', () => {
  test('a read tool never touches this gate', ({ assert }) => {
    assert.doesNotThrow(() => assertActionAllowed(tool('read'), 't1', {}))
    assert.doesNotThrow(() => assertActionAllowed(tool('read'), 't1', undefined))
  })

  test('an action tool is refused while the kill-switch is off', ({ assert }) => {
    // The default, and the whole point: registering a write does not enable it.
    for (const config of [
      undefined,
      {},
      { actionTools: {} },
      { actionTools: { enabled: false } },
    ]) {
      let err: unknown
      try {
        assertActionAllowed(actionTool('write'), 't1', config)
      } catch (e) {
        err = e
      }
      assert.instanceOf(err, AIException, `expected a refusal for ${JSON.stringify(config)}`)
      assert.equal((err as AIException).aiCode, 'tool_action_disabled')
      assert.equal((err as AIException).httpStatus, 403)
    }
  })

  test('an action tool with no summarizeArgs is refused even with the switch on', ({ assert }) => {
    // A human confirming against nothing is a rubber stamp, so this is a refusal
    // rather than a softer default. The message says which of the two rules bit.
    let err: unknown
    try {
      assertActionAllowed(tool('write', 'action'), 't1', ACTIONS_ON)
    } catch (e) {
      err = e
    }
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_action_disabled')
    assert.match((err as AIException).message, /summarizeArgs/)
  })

  test('a well-formed action tool passes once the switch is on', ({ assert }) => {
    // This gate only decides whether writes are possible at all. Whether a human
    // agreed to THIS one is the executor's call, against the arguments.
    assert.doesNotThrow(() => assertActionAllowed(actionTool('write'), 't1', ACTIONS_ON))
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
    await assert.rejects(() => authorizeToolScope(ctx, tenant, tool('read'), {}), /not authorized/)
    assert.deepEqual(
      await authorizeToolScope(ctx, tenant, tool('read'), { acknowledgeUnauthorizedTools: true }),
      { kind: 'allow' }
    )
  })

  test('an ACTION tool ignores acknowledgeUnauthorizedTools', async ({ assert }) => {
    // The ack exists so a host can try READ tools out before wiring authorization:
    // isolation still holds and the worst case is reading its own data. Letting it
    // cover writes would mean one boolean, set once for a demo, silently
    // authorizing every mutation the model can reach.
    let err: unknown
    try {
      await authorizeToolScope(ctx, tenant, actionTool('write'), {
        acknowledgeUnauthorizedTools: true,
        actionTools: { enabled: true },
      })
    } catch (e) {
      err = e
    }
    assert.instanceOf(err, AIException, 'an acked action tool must still be denied')
    assert.equal((err as AIException).aiCode, 'tool_denied')

    // A real hook that really said allow is the only way through.
    assert.deepEqual(
      await authorizeToolScope(ctx, tenant, actionTool('write'), {
        acknowledgeUnauthorizedTools: true,
        actionTools: { enabled: true },
        authorizeTool: () => ({ kind: 'allow' }),
      }),
      { kind: 'allow' }
    )
  })

  test('allow passes the filter through; deny, throw and invalid all reject', async ({
    assert,
  }) => {
    assert.deepEqual(
      await authorizeToolScope(ctx, tenant, tool('read'), {
        authorizeTool: () => ({ kind: 'allow', filter: { s: 1 } }),
      }),
      { kind: 'allow', filter: { s: 1 } }
    )
    await assert.rejects(
      () =>
        authorizeToolScope(ctx, tenant, tool('read'), { authorizeTool: () => ({ kind: 'deny' }) }),
      /not authorized/
    )
    await assert.rejects(
      () =>
        authorizeToolScope(ctx, tenant, tool('read'), {
          authorizeTool: () => {
            throw new Error('acl down')
          },
        }),
      /not authorized/
    )
    await assert.rejects(
      () =>
        authorizeToolScope(ctx, tenant, tool('read'), {
          authorizeTool: () =>
            ({ bad: true }) as unknown as ReturnType<NonNullable<AIToolsConfig['authorizeTool']>>,
        }),
      /not authorized/
    )
  })

  test('a deny is a 403 tool_denied', async ({ assert }) => {
    let err: unknown
    try {
      await authorizeToolScope(ctx, tenant, tool('read'), {
        authorizeTool: () => ({ kind: 'deny' }),
      })
    } catch (e) {
      err = e
    }
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_denied')
    assert.equal((err as AIException).httpStatus, 403)
  })
})
