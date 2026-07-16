import { test } from '@japa/runner'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { replicaLagCheck } from '@adonisjs-lasagna/saas-tenancy/services'
import type { DoctorContext } from '@adonisjs-lasagna/saas-tenancy/services'

const fakeCtx = (): DoctorContext =>
  ({ tenants: [], repo: {} as any, attemptFix: false }) as DoctorContext

/**
 * replica_lag_check coverage. Real streaming replicas need a standby cluster
 * that this test environment doesn't ship, so we exercise the two paths we CAN
 * drive end-to-end:
 *   1. No replicas configured yields an empty issue list.
 *   2. A replica configured against an unreachable host yields exactly one
 *      `replica_unreachable` issue, with the pg error code redacted to a safe
 *      regex (no DSN/credentials leak).
 *
 * The "lag detected" path is left for an environment that has a real standby;
 * the production code path is exercised via the unreachable branch which shares
 * the same connection lifecycle.
 */
test.group('Doctor: replica_lag — error paths (real PG, fake replica)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
  })

  group.each.teardown(() => {
    setConfig(originalConfig)
  })

  test('returns no issues when no replicas are configured', async ({ assert }) => {
    setConfig({ ...originalConfig, tenantReadReplicas: undefined as any })
    const issues = await Promise.resolve(replicaLagCheck.run(fakeCtx()))
    assert.lengthOf(issues, 0, 'absence of config is not an issue')
  })

  test('reports replica_unreachable when the host does not answer', async ({ assert }) => {
    setConfig({
      ...originalConfig,
      tenantReadReplicas: {
        strategy: 'round-robin',
        hosts: [
          // 127.0.0.1:1 is the well-known "nothing listens here" port
          // for connection-refused tests; it never resolves to a real
          // Postgres backend.
          { host: '127.0.0.1', port: 1, name: 'fake-replica-1' },
        ],
      },
    })

    const issues = await Promise.resolve(replicaLagCheck.run(fakeCtx()))
    const unreachable = issues.filter((i: { code: string }) => i.code === 'replica_unreachable')
    assert.lengthOf(
      unreachable,
      1,
      `expected 1 replica_unreachable issue, got ${JSON.stringify(issues)}`
    )
    assert.equal(unreachable[0]!.severity, 'error')
    assert.equal((unreachable[0]!.meta as any).host, 'fake-replica-1')
    assert.match(
      unreachable[0]!.message,
      /pg code: [A-Z0-9_]{1,32}/,
      'message must include a redacted pg code, not raw error text (no credential leak)'
    )
    // Critically: no DSN-shaped substring in the message.
    assert.notMatch(unreachable[0]!.message, /password=|postgres:\/\//i)
  })
})
