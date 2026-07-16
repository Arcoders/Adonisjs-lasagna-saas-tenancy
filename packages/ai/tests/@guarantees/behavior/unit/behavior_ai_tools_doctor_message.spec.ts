import { test } from '@japa/runner'
import { aiToolsCheck, aiToolsPosture } from '../../../../src/services/ai_tools_check.js'
import type { AiConfig, AIToolHostDefinition } from '../../../../src/define_config.js'

/**
 * The ai_tools doctor check + its shared posture reading (WS-AI-11, I7). The
 * posture is read at RUN time through the injected getter, and the boot warning
 * and the check speak with one voice (both read aiToolsPosture). Tool calling is
 * fail-closed: tools offered but no authorizeTool and no acknowledgement is a
 * `warn` (refused); an acknowledged tenant-wide opt-in is an `info`. The
 * action-tool flag adds a separate honest `info`.
 */

const readTool: AIToolHostDefinition = {
  name: 'count_bookings',
  description: 'count bookings',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ count: 0 }),
}

function ai(tools?: Partial<AiConfig['tools']>): AiConfig {
  return {
    allowedProviders: ['claude'],
    ...(tools ? { tools: tools as AiConfig['tools'] } : {}),
  }
}

test.group('ai_tools doctor check', () => {
  test('no config.ai at all reports nothing', ({ assert }) => {
    assert.isNull(aiToolsPosture(undefined))
    assert.deepEqual(aiToolsCheck(() => undefined).run(), [])
  })

  test('a tools block that offers no tools reports nothing', ({ assert }) => {
    const empty = ai({ registry: [] })
    assert.isNull(aiToolsPosture(empty))
    assert.deepEqual(aiToolsCheck(() => empty).run(), [])
  })

  test('a wired authorizeTool is healthy (no issue)', ({ assert }) => {
    const scoped = ai({ registry: [readTool], authorizeTool: () => ({ kind: 'allow' }) })
    assert.isNull(aiToolsPosture(scoped))
    assert.deepEqual(aiToolsCheck(() => scoped).run(), [])
  })

  test('tools offered but no hook and no acknowledgement is a warn (tool calls refused)', ({
    assert,
  }) => {
    const unscoped = ai({ registry: [readTool] })
    const posture = aiToolsPosture(unscoped)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'warn')
    assert.include(posture!.message, 'fail-closed')
    assert.include(posture!.message, 'refused with')

    const issues = aiToolsCheck(() => unscoped).run()
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_tools_unauthorized')
    assert.equal(issues[0].severity, 'warn')
    assert.equal(issues[0].message, posture!.message)
  })

  test('a resolveTools hook counts as offering tools (warn without authorizeTool)', ({
    assert,
  }) => {
    const dynamic = ai({ resolveTools: async () => [readTool] })
    const posture = aiToolsPosture(dynamic)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'warn')
  })

  test('an acknowledged tenant-wide posture is an info issue', ({ assert }) => {
    const acknowledged = ai({ registry: [readTool], acknowledgeUnauthorizedTools: true })
    const posture = aiToolsPosture(acknowledged)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'info')
    assert.include(posture!.message, 'tenant-wide')

    const issues = aiToolsCheck(() => acknowledged).run()
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_tools_acknowledged')
    assert.equal(issues[0].severity, 'info')
  })

  test('the action-tool flag adds a separate honest info (still refused until Phase 3a)', ({
    assert,
  }) => {
    const actionEnabled = ai({
      registry: [readTool],
      authorizeTool: () => ({ kind: 'allow' }),
      actionTools: { enabled: true },
    })
    // authorizeTool is wired, so the only issue is the action-enabled info.
    const issues = aiToolsCheck(() => actionEnabled).run()
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_tools_action_enabled')
    assert.equal(issues[0].severity, 'info')
    assert.include(issues[0].message, 'still refuses')
  })

  test('the check reads config at run time (live posture, not registration time)', ({ assert }) => {
    let current = ai({ registry: [readTool] })
    const check = aiToolsCheck(() => current)
    assert.equal(check.run()[0]?.severity, 'warn')
    current = ai({ registry: [readTool], authorizeTool: () => ({ kind: 'allow' }) })
    assert.deepEqual(check.run(), [])
  })
})
