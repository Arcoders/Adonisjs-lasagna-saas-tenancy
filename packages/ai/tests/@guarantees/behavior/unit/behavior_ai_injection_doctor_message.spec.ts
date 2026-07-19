import { test } from '@japa/runner'
import {
  aiInjectionCheck,
  aiInjectionPosture,
} from '../../../../src/services/ai_injection_check.js'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * Wave 3 acceptance #6: the `ai_injection` doctor check reports the input-injection
 * posture and NEVER fails a run. No classifier wired is the correct no-theater
 * default (info, structural boundary only); a wired classifier reports its
 * scanRetrieved + onError posture (info). Reporting the posture is the honest move;
 * wiring a fake semantic wall as a default would be theater, so the check never warns.
 */

const emptyCtx = { tenants: [], repo: {} as never, attemptFix: false } as DoctorContext

function ai(over: Partial<AiConfig> = {}): AiConfig {
  return { allowedProviders: ['claude'], ...over }
}

test.group('ai_injection doctor check (Wave 3)', () => {
  test('no config.ai at all reports nothing (AI not in use)', async ({ assert }) => {
    assert.isNull(aiInjectionPosture(undefined))
    assert.deepEqual(await aiInjectionCheck(() => undefined).run(emptyCtx), [])
  })

  test('no classifier wired is an INFO naming the structural-only default', async ({ assert }) => {
    const posture = aiInjectionPosture(ai())
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'info')
    assert.equal(posture!.code, 'ai_injection_structural_only')
    assert.include(posture!.message, 'structural boundary')

    const issues = await aiInjectionCheck(() => ai()).run(emptyCtx)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.severity, 'info')
    assert.equal(issues[0]!.code, 'ai_injection_structural_only')
  })

  test('a wired classifier is an INFO naming scanRetrieved + onError', async ({ assert }) => {
    const wired = ai({
      injection: {
        classifier: () => ({ action: 'allow' }),
        scanRetrieved: true,
        onError: 'closed',
      },
    })
    const posture = aiInjectionPosture(wired)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'info')
    assert.equal(posture!.code, 'ai_injection_classifier_wired')
    assert.include(posture!.message, 'scanRetrieved=true')
    assert.include(posture!.message, "onError='closed'")
    assert.include(posture!.message, 'refuses traffic')
  })

  test('a wired classifier defaults onError to open in the message', async ({ assert }) => {
    const wired = ai({ injection: { classifier: () => ({ action: 'allow' }) } })
    const posture = aiInjectionPosture(wired)
    assert.include(posture!.message, "onError='open'")
    assert.include(posture!.message, 'lets input through')
    assert.include(posture!.message, 'scanRetrieved=false')
  })

  test('the check never warns (no posture is a failure) and reads config at run time', async ({
    assert,
  }) => {
    let current = ai()
    const check = aiInjectionCheck(() => current)
    let issues = await check.run(emptyCtx)
    assert.equal(issues[0]!.severity, 'info')

    current = ai({ injection: { classifier: () => ({ action: 'allow' }) } })
    issues = await check.run(emptyCtx)
    assert.equal(issues[0]!.severity, 'info')
    assert.equal(issues[0]!.code, 'ai_injection_classifier_wired')
  })
})
