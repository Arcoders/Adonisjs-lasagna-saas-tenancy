import { test } from '@japa/runner'
import { ADMIN_HEADERS } from './_helpers.js'

// The deploy assets (compose healthchecks, Helm readiness/liveness probes,
// nginx /healthz bypass) all point at these four endpoints, so this spec pins
// what an orchestrator actually sees from the demo app: statuses, the
// auto-registered default checks, criticality flags, and the guarantee that
// probe paths never resolve a tenant (config.ignorePaths). A probe must not
// start failing because a caller sent a junk tenant header.
test.group('e2e — deployment probes', () => {
  test('GET /livez returns 200 without touching dependencies', async ({ client, assert }) => {
    const res = await client.get('/livez')
    res.assertStatus(200)
    assert.equal(res.body().status, 'ok')
    assert.isAtLeast(res.body().uptime, 0)
  })

  test('GET /readyz returns 200 ok with the three default checks passing', async ({
    client,
    assert,
  }) => {
    const res = await client.get('/readyz')
    res.assertStatus(200)
    assert.equal(res.body().status, 'ok')
    assert.properties(res.body().checks, ['backoffice_db', 'redis', 'circuit_breakers'])
    assert.equal(res.body().checks.backoffice_db.status, 'pass')
    assert.equal(res.body().checks.redis.status, 'pass')
    assert.equal(res.body().checks.circuit_breakers.status, 'pass')
  })

  test('the DB and Redis checks are flagged critical in the readyz report', async ({
    client,
    assert,
  }) => {
    const res = await client.get('/readyz')
    assert.isTrue(
      res.body().checks.backoffice_db.critical,
      'backoffice_db must be critical — losing it has to pull the pod'
    )
    assert.isTrue(res.body().checks.redis.critical)
    assert.isUndefined(res.body().checks.circuit_breakers.critical)
  })

  test('GET /healthz mirrors the readyz report', async ({ client, assert }) => {
    const ready = await client.get('/readyz')
    const healthz = await client.get('/healthz')
    assert.equal(healthz.status(), ready.status())
    assert.equal(healthz.body().status, ready.body().status)
  })

  // /metrics is fail-closed in the demo (gated by the backoffice realm); a real
  // Prometheus scrape job carries the credential as a request header too.
  test('GET /metrics serves Prometheus text exposition', async ({ client, assert }) => {
    const res = await client.get('/metrics').headers(ADMIN_HEADERS)
    res.assertStatus(200)
    assert.include(res.header('content-type') ?? '', 'text/plain')
    assert.include(res.text(), 'multitenancy_uptime_seconds')
    assert.include(res.text(), 'multitenancy_tenants_total')
  })

  test('probe paths skip tenant resolution — a junk tenant header cannot break them', async ({
    client,
    assert,
  }) => {
    for (const path of ['/livez', '/readyz', '/healthz']) {
      const res = await client.get(path).header('x-tenant-id', 'not-a-real-tenant')
      assert.equal(res.status(), 200, `${path} must ignore the tenant header`)
    }
  })
})
