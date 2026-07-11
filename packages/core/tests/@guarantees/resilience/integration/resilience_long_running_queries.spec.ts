import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { longRunningQueriesCheck } from '@adonisjs-lasagna/saas-tenancy/services'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'

const fakeCtx = (): DoctorContext =>
  ({ tenants: [], repo: {} as any, attemptFix: false }) as DoctorContext

/**
 * long_running_queries_check end-to-end against real Postgres. Spawns a backend
 * running pg_sleep(N), runs the check with the threshold dropped to 1s, and
 * asserts the check actually surfaces the slow query as an issue. Once the sleep
 * finishes the check goes back to clean.
 */
test.group('Doctor: long_running_queries — real PG state', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      doctor: {
        ...(originalConfig.doctor ?? {}),
        longQueryWarnSeconds: 1,
        longQueryErrorSeconds: 60,
        // This spec asserts on the raw query text, so it exercises the explicit
        // opt-in path. The default scrub (no raw text, fingerprint only) is
        // covered by the unit spec for buildLongQueryIssue.
        includeQueryText: true,
      },
    })
  })

  group.each.teardown(() => {
    setConfig(originalConfig)
  })

  test('flags an active backend running pg_sleep above the warn threshold', async ({ assert }) => {
    // Fire pg_sleep on the `tenant` pool, a different pool from the
    // `central` one the check inspects, so we don't block ourselves
    // waiting on the same pool's only connection. pg_stat_activity is
    // database-wide so the central probe sees the sleep regardless.
    //
    // Use Promise.race against a timeout so JS actually schedules the
    // query. A bare unawaited promise can sit on the microtask queue
    // long enough that pg_stat_activity hasn't seen it yet.
    const sleepPromise = db.connection('tenant').rawQuery('SELECT pg_sleep(8)')
    await Promise.race([
      sleepPromise.then(() => 'done' as const).catch(() => 'err' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ])

    const issues = await Promise.resolve(longRunningQueriesCheck.run(fakeCtx()))
    const slow = issues.filter(
      (i: { code: string }) =>
        i.code === 'long_running_query' || i.code === 'long_running_query_critical'
    )
    assert.isAtLeast(
      slow.length,
      1,
      `expected at least one long_running_query issue, got ${issues.length}: ${JSON.stringify(issues)}`
    )
    const sample = slow[0]!
    assert.equal(
      sample.severity,
      'warn',
      '3-second sleep must be warn, not critical (60s threshold)'
    )
    assert.match(String(sample.meta?.query ?? ''), /pg_sleep/i)
    assert.isString(sample.meta?.queryFingerprint, 'a non-reversible fingerprint is always present')
    assert.isAbove(Number(sample.meta?.durationSeconds ?? 0), 1)

    // Drain the in-flight sleep so we don't leak it past the test.
    await sleepPromise
  })

  test('returns no issues when no backend exceeds the threshold', async ({ assert }) => {
    // Crank the threshold up so any "noise" (the test runner's own
    // queries, a background autovacuum) is well below it.
    setConfig({
      ...getConfig(),
      doctor: {
        ...(getConfig().doctor ?? {}),
        longQueryWarnSeconds: 3600,
        longQueryErrorSeconds: 7200,
      },
    })

    const issues = await Promise.resolve(longRunningQueriesCheck.run(fakeCtx()))
    const slow = issues.filter(
      (i: { code: string }) =>
        i.code === 'long_running_query' || i.code === 'long_running_query_critical'
    )
    assert.lengthOf(slow, 0, 'no real query is running over 1h; check must report nothing')
  })
})
