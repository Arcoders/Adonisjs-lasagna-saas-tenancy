import { test } from '@japa/runner'
import { aiMemoryPosture, aiMemoryCheck } from '../../../../src/services/ai_memory_check.js'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The ai_memory doctor posture (WS-AI-4, gap I): memory binds a session to the
 * resolved principal, so an enabled-but-no-explicit-principal memory is surfaced
 * (info) so it never runs silently inert.
 */

const base = { allowedProviders: ['claude'] } as AiConfig

// The check reads its posture from the injected config getter and never touches the
// run context, so an empty one is all it needs.
const emptyCtx = { tenants: [], repo: {} as any, attemptFix: false } as DoctorContext

test.group('behavior — ai_memory doctor posture', () => {
  test('memory not configured reports nothing', ({ assert }) => {
    assert.isNull(aiMemoryPosture(base))
    assert.isNull(aiMemoryPosture(undefined))
  })

  test('memory enabled with an explicit resolvePrincipal is healthy (null)', ({ assert }) => {
    const config = { ...base, memory: {}, resolvePrincipal: () => 'user-1' } as AiConfig
    assert.isNull(aiMemoryPosture(config))
  })

  test('memory enabled without a resolvePrincipal reports the default-principal info', ({
    assert,
  }) => {
    const posture = aiMemoryPosture({ ...base, memory: { maxTurns: 10 } } as AiConfig)
    assert.isNotNull(posture)
    assert.equal(posture!.code, 'ai_memory_default_principal')
    assert.equal(posture!.severity, 'info')
  })

  test('the doctor check maps the posture to a diagnosis issue', async ({ assert }) => {
    const check = aiMemoryCheck(() => ({ ...base, memory: {} }) as AiConfig)
    assert.equal(check.name, 'ai_memory')
    const issues = await check.run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.code, 'ai_memory_default_principal')
  })

  test('the check reports nothing when memory is off', async ({ assert }) => {
    assert.deepEqual(await aiMemoryCheck(() => base).run(emptyCtx), [])
  })
})
