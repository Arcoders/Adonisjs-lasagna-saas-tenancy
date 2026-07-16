import { test } from '@japa/runner'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * HARDENING: quota atomicity under concurrency (end-to-end through HTTP).
 *
 * `POST /demo/notes` is wrapped in `enforceQuota('apiCallsPerDay')`
 * (examples/api/start/routes.ts), and the free plan caps `apiCallsPerDay` at 50
 * (examples/api/config/multitenancy.ts). The enforcement is a single Redis EVAL
 * (Lua: GET, compare, then INCRBY+EXPIRE only if it fits), so concurrent callers
 * serialize server-side and the counter can never over-grant.
 *
 * To reproduce the documented "limit 10, 10 succeed, 40 rejected" scenario
 * against the real configured limit, we prime the tenant's usage to 40, then
 * fire 50 requests concurrently: exactly 10 must pass (40+10 = 50) and exactly
 * 40 must come back 429, with recorded usage landing on precisely 50 (no race
 * window, no over-consumption).
 *
 * The package's service-level proof lives in
 * packages/core/tests/integration/services/quota_concurrency.spec.ts (50
 * parallel vs limit 10); this is the HTTP-layer companion through the real
 * middleware + exception handler.
 */
test.group('hardening — quota atomicity under concurrency', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('50 concurrent calls against a primed free tenant → exactly 10 ok / 40 × 429', async ({
    client,
    assert,
  }) => {
    const LIMIT = 50 // free plan: apiCallsPerDay
    const PRIME = 40 // pre-consume so the burst straddles the limit
    const BURST = 50 // concurrent callers
    const EXPECTED_OK = LIMIT - PRIME // 10
    const EXPECTED_429 = BURST - EXPECTED_OK // 40

    const { id } = await createInstalledTenant(client, { plan: 'free' })

    // Prime usage to 40. Every one of these must succeed (well under 50).
    for (let i = 0; i < PRIME; i++) {
      const r = await client
        .post('/demo/notes')
        .header('x-tenant-id', id)
        .json({ title: `prime-${i}` })
      assert.equal(r.status(), 201, `priming request ${i} should succeed (usage still < limit)`)
    }

    // Fire the burst concurrently. Promise.all keeps all 50 in flight at once so
    // the Lua check-and-increment is genuinely contended.
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        client
          .post('/demo/notes')
          .header('x-tenant-id', id)
          .json({ title: `burst-${i}` })
      )
    )

    const ok = responses.filter((r) => r.status() === 201)
    const tooMany = responses.filter((r) => r.status() === 429)

    assert.equal(ok.length, EXPECTED_OK, `exactly ${EXPECTED_OK} requests must succeed`)
    assert.equal(tooMany.length, EXPECTED_429, `exactly ${EXPECTED_429} requests must be rejected`)
    assert.equal(
      ok.length + tooMany.length,
      BURST,
      'every response must be either 201 or 429 — no 500s, no dropped requests'
    )

    // The rejection contract: typed code + Retry-After (the demo handler maps
    // QuotaExceededException to { error: { code: 'QUOTA_EXCEEDED', details } }).
    for (const r of tooMany) {
      assert.equal(r.body().error?.code, 'QUOTA_EXCEEDED')
      assert.equal(r.headers()['retry-after'], '60')
      assert.equal(r.body().error?.details?.limit, LIMIT)
    }

    // The decisive anti-over-consumption assertion: the counter must read
    // EXACTLY the limit, never more. A race window would push it past 50.
    const tenant = await Tenant.findOrFail(id)
    const usage = await new QuotaService().getUsage(tenant, 'apiCallsPerDay')
    assert.equal(usage, LIMIT, 'final usage must equal the limit exactly — no over-grant')
  }).timeout(60_000)
})
