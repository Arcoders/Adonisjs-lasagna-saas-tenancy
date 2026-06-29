import { test } from '@japa/runner'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * HARDENING — cross-tenant isolation under HTTP concurrency.
 *
 * Three tenants write to their own `notes` table at the same time, with all
 * requests interleaved in a single Promise.all so the per-tenant connections
 * are genuinely contended. Afterwards we read each tenant's schema DIRECTLY
 * (bypassing the application/service layer) and assert that every row belongs to
 * that tenant and the count matches exactly what it wrote — zero cross-reads.
 *
 * The package's load-bearing proof is
 * packages/core/tests/integration/isolation/cross_tenant_e2e.spec.ts (5 tenants
 * × 20 writes); this is the demo-app companion and additionally checks that
 * reusing a tenant's pooled connection never bleeds another tenant's rows.
 */
test.group('hardening — cross-tenant isolation under concurrency', (group) => {
  const PER_TENANT = 12 // well under the free-plan apiCallsPerDay limit of 50

  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('interleaved concurrent writes never leak rows across tenant schemas', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client, { plan: 'free' })
    const b = await createInstalledTenant(client, { plan: 'free' })
    const c = await createInstalledTenant(client, { plan: 'free' })

    const tenants = [
      { id: a.id, prefix: 'A' },
      { id: b.id, prefix: 'B' },
      { id: c.id, prefix: 'C' },
    ]

    // Build every write up front, then fire them ALL at once so the three
    // tenants' requests are interleaved rather than run tenant-by-tenant.
    const writes = tenants.flatMap((t) =>
      Array.from({ length: PER_TENANT }, (_, i) =>
        client
          .post('/demo/notes')
          .header('x-tenant-id', t.id)
          .json({ title: `${t.prefix}::note::${i}` })
      )
    )
    const results = await Promise.all(writes)
    assert.isTrue(
      results.every((r) => r.status() === 201),
      'every concurrent write must succeed (all under the quota)'
    )

    // Direct-DB verification per tenant: read straight from the schema, not via
    // the controller, so the application layer cannot mask a leak.
    for (const t of tenants) {
      const conn = (await Tenant.findOrFail(t.id)).getConnection()
      const res = await conn.rawQuery('SELECT title FROM notes ORDER BY title')
      const titles: string[] = res.rows.map((r: { title: string }) => r.title)

      assert.lengthOf(
        titles,
        PER_TENANT,
        `tenant ${t.prefix} must hold exactly its own ${PER_TENANT} rows`
      )
      assert.isTrue(
        titles.every((title) => title.startsWith(`${t.prefix}::`)),
        `every row in tenant ${t.prefix}'s schema must belong to ${t.prefix} (zero cross-reads)`
      )
    }

    // Pooled-connection reuse: read A, then B, then A again on the reused
    // connections. A's second read must be identical to its first and share no
    // rows with B — proving per-tenant connections don't bleed under reuse.
    const connA = (await Tenant.findOrFail(a.id)).getConnection()
    const connB = (await Tenant.findOrFail(b.id)).getConnection()
    const a1 = (await connA.rawQuery('SELECT title FROM notes')).rows.map((r: any) => r.title)
    const bRows = (await connB.rawQuery('SELECT title FROM notes')).rows.map((r: any) => r.title)
    const a2 = (await connA.rawQuery('SELECT title FROM notes')).rows.map((r: any) => r.title)

    assert.sameMembers(a1, a2, "A's reused connection must return a stable, A-only row set")
    assert.isEmpty(
      a1.filter((title: string) => bRows.includes(title)),
      'A and B must share zero rows even when their connections are reused back-to-back'
    )
  }).timeout(60_000)
})
