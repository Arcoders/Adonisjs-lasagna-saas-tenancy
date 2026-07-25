import { test } from '@japa/runner'
import {
  determinePgBouncerPosture,
  probePgBouncerAtBoot,
  getDetectedPgBouncerPosture,
  __resetPgBouncerPostureForTests,
} from '../../../../src/services/isolation/pgbouncer_probe.js'
import pgBouncerCheck from '../../../../src/services/doctor/checks/pgbouncer_check.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import type { PgBouncerConfig } from '../../../../src/types/config/isolation.js'

/**
 * F3 — PgBouncer posture determination is conservative and fail-closed: `auto`
 * never ASSUMES transaction pooling, the routing path is reported pooler-safe, no
 * cap is touched, and a probe against an unreachable database still yields a
 * posture instead of throwing. The doctor check reports the result.
 */

test.group('determinePgBouncerPosture (F3)', () => {
  test('absent / off is disabled', ({ assert }) => {
    assert.equal(determinePgBouncerPosture(undefined).mode, 'off')
    assert.equal(determinePgBouncerPosture({ mode: 'off' }).mode, 'off')
    assert.equal(determinePgBouncerPosture({}).mode, 'off')
  })

  test('a declared mode is recorded and reported pooler-safe', ({ assert }) => {
    for (const mode of ['transaction', 'session'] as const) {
      const p = determinePgBouncerPosture({ mode })
      assert.equal(p.mode, mode)
      assert.equal(p.source, 'declared')
      assert.isTrue(p.transactionSafe)
    }
  })

  test('auto never assumes transaction pooling (fail-closed to unknown)', ({ assert }) => {
    const p = determinePgBouncerPosture({ mode: 'auto' })
    assert.equal(p.mode, 'unknown', 'auto does not claim a pooling mode it cannot confirm')
    assert.equal(p.source, 'auto-inconclusive')
    assert.isTrue(p.transactionSafe, 'the routing path is transaction-safe regardless')
  })
})

test.group('probePgBouncerAtBoot (F3)', (group) => {
  group.each.setup(() => {
    __resetConfigForTests()
    __resetPgBouncerPostureForTests()
  })
  group.each.teardown(() => {
    __resetConfigForTests()
    __resetPgBouncerPostureForTests()
  })

  function configure(pgBouncer: PgBouncerConfig): void {
    setConfig({ ...testConfig, isolation: { driver: 'schema-pg', pgBouncer } } as any)
  }

  test('records the posture and reaches the doctor check', async ({ assert }) => {
    configure({ mode: 'transaction' })
    const posture = await probePgBouncerAtBoot({ ping: async () => {} })

    assert.equal(posture.mode, 'transaction')
    assert.equal(getDetectedPgBouncerPosture()?.mode, 'transaction')

    const issues = await pgBouncerCheck.run({} as any)
    assert.lengthOf(issues, 1)
    assert.equal(issues[0]!.severity, 'info')
    // Static code, mode in meta (a dynamic `code:` is banned by the fix-coverage census).
    assert.equal(issues[0]!.code, 'pgbouncer_pooling_mode')
    assert.equal((issues[0]!.meta as { mode?: string }).mode, 'transaction')
  })

  test('an unreachable database does not throw; the posture still resolves', async ({ assert }) => {
    configure({ mode: 'session' })
    const posture = await probePgBouncerAtBoot({
      ping: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    assert.equal(posture.mode, 'session', 'a failed ping degrades, never throws')
  })

  test('auto surfaces a warn in the doctor check advising explicit declaration', async ({
    assert,
  }) => {
    configure({ mode: 'auto' })
    await probePgBouncerAtBoot({ ping: async () => {} })

    const issues = await pgBouncerCheck.run({} as any)
    assert.equal(issues[0]!.severity, 'warn')
    assert.equal(issues[0]!.code, 'pgbouncer_mode_unknown')
  })

  test('off reports nothing from the doctor check', async ({ assert }) => {
    configure({ mode: 'off' })
    await probePgBouncerAtBoot({ ping: async () => {} })
    assert.lengthOf(await pgBouncerCheck.run({} as any), 0)
  })
})
