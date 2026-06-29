import { test } from '@japa/runner'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * INTENTIONAL CHAOS FIXTURE. Do NOT "fix" the missing restore in the first group
 * below: it deliberately leaks a config swap to prove, end to end through the real
 * Japa lifecycle, that the test-kit's config-baseline guard restores the boot
 * baseline before the next group runs. A single warning from the guard naming the
 * "leaks a config swap" group is EXPECTED on every run; it is the guard working.
 *
 * The two groups live in one file so they run back to back in definition order,
 * which makes the proof independent of Japa's undefined cross-file ordering: the
 * guard's `group:end` after the leak group must clean up before the assertion
 * group starts. (The guard logic itself is unit-tested in
 * packages/satellite-test-kit/tests/unit/config_baseline.spec.ts; this proves the
 * wiring.)
 */
const SENTINEL = '__chaos_config_leak_marker__'

test.group('chaos: a group that leaks a config swap (intentional, do not fix)', (group) => {
  group.setup(() => {
    // Swap the config and deliberately never restore it.
    setConfig({ ...getConfig(), [SENTINEL]: true } as never)
  })

  test('the leaked sentinel is visible within the leaking group', ({ assert }) => {
    assert.isTrue((getConfig() as unknown as Record<string, unknown>)[SENTINEL] === true)
  })
})

test.group('chaos: the next group must see the restored baseline', () => {
  test('the harness config-baseline guard removed the leaked sentinel', ({ assert }) => {
    assert.isUndefined((getConfig() as unknown as Record<string, unknown>)[SENTINEL])
  })
})
