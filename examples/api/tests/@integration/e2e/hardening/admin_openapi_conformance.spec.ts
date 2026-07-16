import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { ADMIN_HEADERS, createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * HARDENING surface: the admin REST API and its OpenAPI 3.1 conformance.
 *
 * The admin API is mounted at `/admin` (examples/api/start/routes.ts) and serves
 * an OpenAPI 3.1 document at `/admin/openapi.json`, generated at runtime by
 * packages/admin/src/openapi.ts, so there is no static spec file. This suite
 * asserts the document is well-formed 3.1, that the satellite endpoints it
 * declares actually respond, that auth is enforced (fail-closed), and that an
 * unknown tenant yields 404. The cross-check between the router and the spec at
 * the unit level is packages/core/tests/unit/admin/openapi.spec.ts; this is the
 * live companion.
 */
test.group('hardening — admin API & OpenAPI conformance', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('GET /admin/openapi.json is a well-formed OpenAPI 3.1 document', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/admin/openapi.json').headers(ADMIN_HEADERS)
    r.assertStatus(200)

    const spec = r.body()
    assert.equal(spec.openapi, '3.1.0', 'must declare OpenAPI 3.1.0')
    assert.isString(spec.info?.title)
    assert.isString(spec.info?.version)
    assert.isObject(spec.paths)
    assert.isObject(spec.components?.schemas)

    const paths = Object.keys(spec.paths)
    assert.isAtLeast(paths.length, 15, 'the admin surface declares many paths')

    // Every satellite family the demo mounts must be present in the spec.
    for (const family of [
      'tenants',
      'audit-logs',
      'webhooks',
      'feature-flags',
      'branding',
      'sso',
      'metrics',
      'quotas',
      'impersonations',
    ]) {
      assert.isTrue(
        paths.some((p) => p.includes(family)),
        `OpenAPI paths must declare the "${family}" family`
      )
    }
  })

  test('the admin API is fail-closed — no token is rejected', async ({ client }) => {
    const a = await client.get('/admin/tenants')
    a.assertStatus(401)
    // The spec/docs are gated by default too, so they cannot be enumerated anonymously.
    const b = await client.get('/admin/openapi.json')
    b.assertStatus(401)
  })

  test('an unknown tenant id returns 404', async ({ client }) => {
    const r = await client.get(`/admin/tenants/${randomUUID()}`).headers(ADMIN_HEADERS)
    r.assertStatus(404)
  })

  test('the declared satellite read endpoints respond for a real tenant', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { plan: 'pro' })

    const list = await client.get('/admin/tenants').headers(ADMIN_HEADERS)
    list.assertStatus(200)
    assert.isArray(list.body().data, 'tenant list must serialize to a data array')

    const show = await client.get(`/admin/tenants/${id}`).headers(ADMIN_HEADERS)
    show.assertStatus(200)
    assert.equal(show.body().data.id, id)
    assert.equal(show.body().data.status, 'active')
    assert.isString(show.body().data.schemaName)

    // List/aggregate endpoints return 200 even when empty for a fresh tenant.
    for (const path of ['audit-logs', 'feature-flags', 'webhooks', 'quotas']) {
      const res = await client.get(`/admin/tenants/${id}/${path}`).headers(ADMIN_HEADERS)
      assert.equal(res.status(), 200, `GET /admin/tenants/:id/${path} must respond 200`)
    }

    // Show-style satellite endpoints are declared but may be empty (404) when
    // unconfigured, and both are conformant. They must never 401/500 with a token.
    for (const path of ['branding', 'sso', 'metrics']) {
      const res = await client.get(`/admin/tenants/${id}/${path}`).headers(ADMIN_HEADERS)
      assert.oneOf(
        res.status(),
        [200, 404],
        `GET /admin/tenants/:id/${path} must be 200 or 404, got ${res.status()}`
      )
    }
  })
})
