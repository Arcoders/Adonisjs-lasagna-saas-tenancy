import { test } from '@japa/runner'
import { aiToolsCheck, aiToolsPosture } from '../../../../src/services/ai_tools_check.js'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig, AIToolHostDefinition } from '../../../../src/define_config.js'

/**
 * The ai_tools doctor check + its shared posture reading. The
 * posture is read at RUN time through the injected getter, and the boot warning
 * and the check speak with one voice (both read aiToolsPosture). Tool calling is
 * fail-closed: tools offered but no authorizeTool and no acknowledgement is a
 * `warn` (refused); an acknowledged tenant-wide opt-in is an `info`. The
 * action-tool flag adds a separate honest `info`.
 */

// The check reads its posture from the injected config getter and never touches the
// run context, so an empty one is all it needs.
const emptyCtx = { tenants: [], repo: {} as any, attemptFix: false } as DoctorContext

const readTool: AIToolHostDefinition = {
  name: 'count_bookings',
  description: 'count bookings',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ count: 0 }),
}

/** A well-formed action tool: mutating and carrying the human summary. */
const actionTool: AIToolHostDefinition = {
  name: 'cancel_booking',
  description: 'cancel a booking',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  mode: 'action',
  summarizeArgs: (args) => `cancel ${String(args.id)}`,
  handler: async () => ({ cancelled: true }),
}

/** An action tool missing summarizeArgs: unadvertised, refused at plan time. */
const actionNoSummary: AIToolHostDefinition = {
  name: 'delete_all',
  description: 'delete everything',
  inputSchema: { type: 'object', properties: {} },
  mode: 'action',
  handler: async () => ({ deleted: true }),
}

function ai(tools?: Partial<AiConfig['tools']>, audit?: AiConfig['audit']): AiConfig {
  return {
    allowedProviders: ['claude'],
    ...(tools ? { tools: tools as NonNullable<AiConfig['tools']> } : {}),
    ...(audit ? { audit } : {}),
  }
}

test.group('ai_tools doctor check', () => {
  test('no config.ai at all reports nothing', async ({ assert }) => {
    assert.isNull(aiToolsPosture(undefined))
    assert.deepEqual(await aiToolsCheck(() => undefined).run(emptyCtx), [])
  })

  test('a tools block that offers no tools reports nothing', async ({ assert }) => {
    const empty = ai({ registry: [] })
    assert.isNull(aiToolsPosture(empty))
    assert.deepEqual(await aiToolsCheck(() => empty).run(emptyCtx), [])
  })

  test('a wired authorizeTool is healthy (no issue)', async ({ assert }) => {
    const scoped = ai({ registry: [readTool], authorizeTool: () => ({ kind: 'allow' }) })
    assert.isNull(aiToolsPosture(scoped))
    assert.deepEqual(await aiToolsCheck(() => scoped).run(emptyCtx), [])
  })

  test('tools offered but no hook and no acknowledgement is a warn (tool calls refused)', async ({
    assert,
  }) => {
    const unscoped = ai({ registry: [readTool] })
    const posture = aiToolsPosture(unscoped)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'warn')
    assert.include(posture!.message, 'fail-closed')
    assert.include(posture!.message, 'refused with')

    const issues = await aiToolsCheck(() => unscoped).run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'ai_tools_unauthorized')
    assert.equal(issues[0]!.severity, 'warn')
    assert.equal(issues[0]!.message, posture!.message)
  })

  test('a resolveTools hook counts as offering tools (warn without authorizeTool)', ({
    assert,
  }) => {
    const dynamic = ai({ resolveTools: async () => [readTool] })
    const posture = aiToolsPosture(dynamic)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'warn')
  })

  test('an acknowledged tenant-wide posture is an info issue', async ({ assert }) => {
    const acknowledged = ai({ registry: [readTool], acknowledgeUnauthorizedTools: true })
    const posture = aiToolsPosture(acknowledged)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'info')
    assert.include(posture!.message, 'tenant-wide')

    const issues = await aiToolsCheck(() => acknowledged).run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'ai_tools_acknowledged')
    assert.equal(issues[0]!.severity, 'info')
  })

  test('actions enabled + audit on: an honest info that a confirmed action runs', async ({
    assert,
  }) => {
    const actionEnabled = ai({
      registry: [readTool, actionTool],
      authorizeTool: () => ({ kind: 'allow' }),
      actionTools: { enabled: true },
    })
    // authorizeTool is wired and the action tool is well-formed: the only issue is
    // the honest action-enabled info.
    const issues = await aiToolsCheck(() => actionEnabled).run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'ai_tools_action_enabled')
    assert.equal(issues[0]!.severity, 'info')
    assert.include(issues[0]!.message, 'after a human confirms it')
    assert.include(issues[0]!.message, 'HONEST LIMIT')
  })

  test('actions enabled but audit off: a warn that every action is refused', async ({ assert }) => {
    const actionsNoAudit = ai(
      {
        registry: [actionTool],
        authorizeTool: () => ({ kind: 'allow' }),
        actionTools: { enabled: true },
      },
      { enabled: false }
    )
    const issues = await aiToolsCheck(() => actionsNoAudit).run(emptyCtx)
    // The needs-audit warn short-circuits: with audit off, nothing can run, so the
    // per-tool nits and the "live" info are moot.
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'ai_tools_action_needs_audit')
    assert.equal(issues[0]!.severity, 'warn')
    assert.include(issues[0]!.message, 'tool_action_unavailable')
  })

  test('actions enabled but a registry action tool has no summarizeArgs: a warn naming it', async ({
    assert,
  }) => {
    const missingSummary = ai({
      registry: [actionTool, actionNoSummary],
      authorizeTool: () => ({ kind: 'allow' }),
      actionTools: { enabled: true },
    })
    const issues = await aiToolsCheck(() => missingSummary).run(emptyCtx)
    const warn = issues.find((i) => i.code === 'ai_tools_action_no_summary')
    assert.exists(warn, 'a missing-summary action tool must be surfaced')
    assert.equal(warn!.severity, 'warn')
    assert.include(warn!.message, 'delete_all')
    assert.notInclude(warn!.message, 'cancel_booking', 'the well-formed tool is not flagged')
    // The honest info still fires alongside (a confirmed action can run).
    assert.exists(issues.find((i) => i.code === 'ai_tools_action_enabled'))
  })

  test('actions enabled but a registry action tool sets requiresConfirmation:false: a warn', async ({
    assert,
  }) => {
    const autoExec: AIToolHostDefinition = {
      ...actionTool,
      name: 'auto_cancel',
      requiresConfirmation: false,
    }
    const cfg = ai({
      registry: [autoExec],
      authorizeTool: () => ({ kind: 'allow' }),
      actionTools: { enabled: true },
    })
    const issues = await aiToolsCheck(() => cfg).run(emptyCtx)
    const warn = issues.find((i) => i.code === 'ai_tools_action_auto_execute')
    assert.exists(warn)
    assert.equal(warn!.severity, 'warn')
    assert.include(warn!.message, 'auto_cancel')
  })

  test('the check reads config at run time (live posture, not registration time)', async ({
    assert,
  }) => {
    let current = ai({ registry: [readTool] })
    const check = aiToolsCheck(() => current)
    assert.equal((await check.run(emptyCtx))[0]?.severity, 'warn')
    current = ai({ registry: [readTool], authorizeTool: () => ({ kind: 'allow' }) })
    assert.deepEqual(await check.run(emptyCtx), [])
  })
})
