import { test } from '@japa/runner'
import { aiTokensBudgetPosture, aiBudgetCheck } from '../../../../src/services/ai_budget_check.js'
import type { MultitenancyConfigWithAi } from '../../../../src/define_config.js'

/**
 * The aiTokens budget posture, from the STATIC config. It exists to catch the
 * production footgun commit 09809a8 documented: with neither a per-plan
 * limits.aiTokens nor plans.operatorCeiling.aiTokens, the kernel reserve is
 * inert and the AI endpoint runs unmetered. A host that budgets via a dynamic
 * getPlan is invisible to a static read, so that case is an info, never a warn
 * (a hard block would false-positive it). That is the whole reason the boot side does
 * not refuse to mount.
 */

function config(over: {
  ai?: boolean | Record<string, unknown>
  plans?: Record<string, unknown>
}): MultitenancyConfigWithAi | undefined {
  const ai =
    over.ai === false
      ? undefined
      : over.ai === true || over.ai === undefined
        ? { allowedProviders: ['claude'] }
        : { allowedProviders: ['claude'], ...over.ai }
  return { ai, plans: over.plans } as unknown as MultitenancyConfigWithAi
}

test.group('aiTokens budget posture', () => {
  test('no config.ai is healthy: nothing to meter', ({ assert }) => {
    assert.isNull(aiTokensBudgetPosture(config({ ai: false, plans: {} })))
    assert.isNull(aiTokensBudgetPosture(undefined))
  })

  test('an operator ceiling on aiTokens is healthy (it meters every tenant)', ({ assert }) => {
    const posture = aiTokensBudgetPosture(
      config({ plans: { operatorCeiling: { aiTokens: 1_000_000 }, definitions: {} } })
    )
    assert.isNull(posture)
  })

  test('a per-plan budget without an operator ceiling is an info nudge', ({ assert }) => {
    const posture = aiTokensBudgetPosture(
      config({ plans: { definitions: { free: { limits: { aiTokens: 5000 } } } } })
    )
    assert.equal(posture?.severity, 'info')
    assert.equal(posture?.code, 'ai_budget_no_operator_ceiling')
  })

  test('completely unbudgeted, not acknowledged, no dynamic plans is a warn', ({ assert }) => {
    const posture = aiTokensBudgetPosture(
      config({ plans: { definitions: { free: { limits: { apiCallsPerDay: 50 } } } } })
    )
    assert.equal(posture?.severity, 'warn')
    assert.equal(posture?.code, 'ai_budget_unbudgeted')
    assert.match(posture!.message, /denial-of-wallet/)
  })

  test('acknowledging the unbudgeted quota downgrades the warn to an info', ({ assert }) => {
    const posture = aiTokensBudgetPosture(
      config({ ai: { acknowledgeUnbudgetedAiTokens: true }, plans: { definitions: {} } })
    )
    assert.equal(posture?.severity, 'info')
    assert.equal(posture?.code, 'ai_budget_unbudgeted_acknowledged')
  })

  test('a dynamic getPlan is an info, never a warn (the static read cannot see it)', ({
    assert,
  }) => {
    const withGetPlan = aiTokensBudgetPosture(
      config({ plans: { definitions: {}, getPlan: () => 'free' } })
    )
    assert.equal(withGetPlan?.severity, 'info')
    assert.equal(withGetPlan?.code, 'ai_budget_dynamic_plans')

    const withStorage = aiTokensBudgetPosture(
      config({ plans: { definitions: {}, storage: 'tenant_plans' } })
    )
    assert.equal(withStorage?.severity, 'info')
    assert.equal(withStorage?.code, 'ai_budget_dynamic_plans')
  })

  test('the doctor check maps the posture to issues (healthy => none)', async ({ assert }) => {
    const healthy = aiBudgetCheck(() =>
      config({ plans: { operatorCeiling: { aiTokens: 1000 }, definitions: {} } })
    )
    assert.deepEqual(await healthy.run({} as never), [])

    const unbudgeted = aiBudgetCheck(() => config({ plans: { definitions: {} } }))
    const issues = await unbudgeted.run({} as never)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.severity, 'warn')
    assert.equal(issues[0]!.code, 'ai_budget_unbudgeted')
  })
})
