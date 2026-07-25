import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  aiMembershipGateRisk,
  assertAiMountAllowed,
  isAbsentAiMiddleware,
} from '../../../../src/routes/mount_gate.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The mount matrix, on the pure gate (the boot-unsafe `routes.ts` wrapper only adds
 * the router calls): every refusal names its reason in the `guard.ai_route_mount`
 * emission, the empty-array middleware trap is closed, and the acknowledged posture
 * mounts WITH a warning, never silently.
 */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function aiWith(overrides: Partial<AiConfig> = {}): AiConfig {
  return { allowedProviders: ['claude'], ...overrides } as AiConfig
}

test.group('AI mount gate', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('isAbsentAiMiddleware closes every effectively-absent shape', ({ assert }) => {
    for (const absent of [undefined, null, '', []]) {
      assert.isTrue(isAbsentAiMiddleware(absent), `should be absent: ${JSON.stringify(absent)}`)
    }
    for (const present of ['auth', () => {}, [() => {}], { handle: () => {} }, ['auth']]) {
      assert.isFalse(isAbsentAiMiddleware(present))
    }
  })

  test('an absent middleware chain refuses to mount (reason middleware_missing)', async ({
    assert,
  }) => {
    for (const middleware of [undefined, null, '', []]) {
      assert.throws(
        () => assertAiMountAllowed({ middleware: middleware as never }, aiWith()),
        /Refusing to mount AI routes without a middleware chain/
      )
    }
    await settle()
    assert.lengthOf(captured, 4)
    for (const payload of captured) {
      assert.equal(payload.id, 'guard.ai_route_mount')
      assert.equal(payload.metadata.reason, 'middleware_missing')
    }
  })

  test('an absent config.ai refuses to mount (reason config_missing)', async ({ assert }) => {
    assert.throws(
      () => assertAiMountAllowed({ middleware: 'auth' }, undefined),
      /Refusing to mount AI routes: config\.ai is absent/
    )
    await settle()
    assert.equal(captured[0]?.metadata.reason, 'config_missing')
  })

  test('no membership gate and no acknowledgement refuses to mount', async ({ assert }) => {
    assert.throws(
      () => assertAiMountAllowed({ middleware: 'auth' }, aiWith()),
      /Refusing to mount AI routes without a membership gate/
    )
    await settle()
    assert.equal(captured[0]?.metadata.reason, 'no_membership_gate')
  })

  test('the acknowledged posture mounts WITH a warning, never silently', async ({ assert }) => {
    const { warning } = assertAiMountAllowed(
      { middleware: 'auth' },
      aiWith({ acknowledgeNoMembershipGate: true })
    )
    assert.isString(warning)
    assert.match(warning!, /WITHOUT a membership gate/)
    await settle()
    assert.lengthOf(captured, 0, 'an allowed mount must not emit')
  })

  test('a wired hook mounts clean: no warning, no emission', async ({ assert }) => {
    const result = assertAiMountAllowed(
      { middleware: ['auth'] },
      aiWith({ authorizeAIAccess: () => true })
    )
    assert.deepEqual(result, {})
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('aiMembershipGateRisk speaks with one voice for the warning and the doctor check', ({
    assert,
  }) => {
    assert.isNull(aiMembershipGateRisk(undefined))
    assert.isNull(aiMembershipGateRisk(aiWith({ authorizeAIAccess: () => true })))
    assert.match(
      aiMembershipGateRisk(aiWith({ acknowledgeNoMembershipGate: true }))!,
      /WITHOUT a membership gate/
    )
    assert.match(aiMembershipGateRisk(aiWith())!, /refuse to mount/)
  })
})
