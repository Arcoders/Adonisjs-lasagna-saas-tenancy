import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { HealthService, registerDefaultChecks } from '@adonisjs-lasagna/saas-tenancy/health'

/**
 * The deployment docs promise that `/readyz` is what keeps a broken pod out
 * of rotation: 200 while the pod can serve, 503 when it cannot. This spec
 * pins those semantics over real HTTP (the same path a Kubernetes
 * readinessProbe or compose healthcheck hits), including the rules that are
 * easy to get wrong operationally:
 *
 *   - the provider registers backoffice_db (critical), redis (critical) and
 *     circuit_breakers (non-critical) at boot;
 *   - a failing NON-critical check degrades the report but keeps the 200;
 *   - a failing CRITICAL check flips the aggregate to fail → 503;
 *   - when every check fails the report is fail → 503 (legacy rule);
 *   - /healthz mirrors /readyz.
 *
 * Routes are mounted in the fixture at /ops (tests/fixtures/start/routes.ts).
 */
test.group('Health probes over HTTP (integration)', (group) => {
  /**
   * Put the process back the way the provider's boot() left it: clear the
   * default names, then re-register through the same `registerDefaultChecks`
   * the provider uses, so this spec can never drift from the real defaults.
   */
  async function restoreDefaults(): Promise<void> {
    const svc = await app.container.make(HealthService)
    for (const name of ['backoffice_db', 'redis', 'circuit_breakers']) {
      svc.removeCheck(name)
    }
    registerDefaultChecks(svc)
  }

  group.each.teardown(async () => {
    const svc = await app.container.make(HealthService)
    svc.removeCheck('synthetic_soft')
    svc.removeCheck('synthetic_critical')
    svc.removeCheck('synthetic_fail_a')
    svc.removeCheck('synthetic_fail_b')
    await restoreDefaults()
  })

  test('GET /ops/livez returns 200 with ok status and a numeric uptime', async ({
    client,
    assert,
  }) => {
    const res = await client.get('/ops/livez')
    res.assertStatus(200)
    assert.equal(res.body().status, 'ok')
    assert.isAtLeast(res.body().uptime, 0)
  })

  test('GET /ops/readyz serves the boot-registered default checks against live infra', async ({
    client,
    assert,
  }) => {
    const res = await client.get('/ops/readyz')
    res.assertStatus(200)
    assert.equal(res.body().status, 'ok')
    assert.properties(res.body().checks, ['backoffice_db', 'redis', 'circuit_breakers'])
    assert.equal(res.body().checks.backoffice_db.status, 'pass')
    assert.equal(res.body().checks.redis.status, 'pass')
  })

  test('the default backoffice_db and redis checks are critical, circuit_breakers is not', async ({
    assert,
  }) => {
    const svc = await app.container.make(HealthService)
    assert.isTrue(svc.isCritical('backoffice_db'))
    assert.isTrue(svc.isCritical('redis'))
    assert.isFalse(svc.isCritical('circuit_breakers'))
  })

  test('a failing non-critical check reads degraded but keeps the 200', async ({
    client,
    assert,
  }) => {
    const svc = await app.container.make(HealthService)
    svc.addCheck('synthetic_soft', () => ({ status: 'fail', durationMs: 0, message: 'synthetic' }))

    const res = await client.get('/ops/readyz')
    res.assertStatus(200)
    assert.equal(res.body().status, 'degraded')
    assert.equal(res.body().checks.synthetic_soft.status, 'fail')
  })

  test('a failing critical check returns 503 even while every other check passes', async ({
    client,
    assert,
  }) => {
    const svc = await app.container.make(HealthService)
    svc.addCheck(
      'synthetic_critical',
      () => ({ status: 'fail', durationMs: 0, message: 'synthetic outage' }),
      { critical: true }
    )

    const res = await client.get('/ops/readyz')
    res.assertStatus(503)
    assert.equal(res.body().status, 'fail')
    assert.isTrue(res.body().checks.synthetic_critical.critical)
    assert.equal(res.body().checks.backoffice_db.status, 'pass')
  })

  test('when every registered check fails the report is fail → 503', async ({ client, assert }) => {
    const svc = await app.container.make(HealthService)
    for (const name of ['backoffice_db', 'redis', 'circuit_breakers']) {
      svc.removeCheck(name)
    }
    svc.addCheck('synthetic_fail_a', () => ({ status: 'fail', durationMs: 0 }))
    svc.addCheck('synthetic_fail_b', () => ({ status: 'fail', durationMs: 0 }))

    const res = await client.get('/ops/readyz')
    res.assertStatus(503)
    assert.equal(res.body().status, 'fail')
  })

  test('GET /ops/healthz mirrors the readyz status code and report', async ({ client, assert }) => {
    const ready = await client.get('/ops/readyz')
    const healthz = await client.get('/ops/healthz')
    assert.equal(healthz.status(), ready.status())
    assert.equal(healthz.body().status, ready.body().status)

    const svc = await app.container.make(HealthService)
    svc.addCheck('synthetic_critical', () => ({ status: 'fail', durationMs: 0 }), {
      critical: true,
    })
    const failing = await client.get('/ops/healthz')
    failing.assertStatus(503)
  })
})
