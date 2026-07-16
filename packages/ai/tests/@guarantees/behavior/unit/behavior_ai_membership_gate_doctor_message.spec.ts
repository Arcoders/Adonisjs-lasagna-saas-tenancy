import { test } from '@japa/runner'
import { aiMembershipGateCheck } from '../../../../src/services/ai_membership_gate_check.js'
import { aiMembershipGateRisk } from '../../../../src/routes/mount_gate.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The `ai_membership_gate` doctor check speaks with the mount warning's voice
 * (both read aiMembershipGateRisk) and reads config at RUN time, so a posture
 * change between runs is reported live.
 */

const doctorCtx = { tenants: [], repo: {} as never, attemptFix: false }

test.group('ai_membership_gate doctor check', () => {
  test('a wired hook and an absent ai block are both healthy', ({ assert }) => {
    for (const ai of [
      undefined,
      { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig,
    ]) {
      const check = aiMembershipGateCheck(() => ai)
      assert.deepEqual(check.run(doctorCtx), [])
    }
  })

  test('the acknowledged opt-out is an info issue with the shared wording', ({ assert }) => {
    const ai = { allowedProviders: ['claude'], acknowledgeNoMembershipGate: true } as AiConfig
    const issues = aiMembershipGateCheck(() => ai).run(doctorCtx)

    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_membership_gate_acknowledged')
    assert.equal(issues[0].severity, 'info')
    assert.equal(issues[0].message, aiMembershipGateRisk(ai))
  })

  test('neither hook nor acknowledgement is a warn issue naming the mount refusal', ({
    assert,
  }) => {
    const ai = { allowedProviders: ['claude'] } as AiConfig
    const issues = aiMembershipGateCheck(() => ai).run(doctorCtx)

    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_membership_gate_missing')
    assert.equal(issues[0].severity, 'warn')
    assert.match(issues[0].message, /refuse to mount/)
  })

  test('the check reads config at run time, not at construction', ({ assert }) => {
    let ai: AiConfig | undefined = { allowedProviders: ['claude'] } as AiConfig
    const check = aiMembershipGateCheck(() => ai)

    assert.lengthOf(check.run(doctorCtx), 1)
    ai = { allowedProviders: ['claude'], authorizeAIAccess: () => true } as AiConfig
    assert.lengthOf(check.run(doctorCtx), 0)
  })

  test('the check carries the stable name operators target with --check', ({ assert }) => {
    const check = aiMembershipGateCheck(() => undefined)
    assert.equal(check.name, 'ai_membership_gate')
    assert.isAbove(check.description.length, 20)
  })
})
