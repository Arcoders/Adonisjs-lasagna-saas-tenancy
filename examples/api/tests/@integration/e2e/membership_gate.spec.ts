import { test } from '@japa/runner'
import { createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * The `authorizeTenantAccess` seam, attacked through the booted HTTP stack rather
 * than asserted against a service double.
 *
 * Header-based resolution is trust-the-input: whoever sends `x-tenant-id` picks the
 * tenant. That is a cross-tenant IDOR unless the host proves the caller's principal
 * belongs to the tenant it resolved. `config/multitenancy.ts` wires the demo's gate
 * off a stand-in principal header, and TenantGuardMiddleware refuses the request
 * with a 403 before any controller runs.
 *
 * Core covers the same seam against its fixture app in
 * `security_tenant_guard_authorize.spec.ts`; this is the real-HTTP twin, and it
 * used to live inside the crypto e2e that shipped with the crypto satellite.
 */
test.group('membership gate — cross-tenant IDOR firewall (real HTTP)', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('a principal from tenant B resolving tenant A is refused with 403', async ({ client }) => {
    const a = await createInstalledTenant(client, { plan: 'pro' })
    const b = await createInstalledTenant(client, { plan: 'pro' })

    // The caller swaps x-tenant-id to A, but its authenticated principal is B's.
    const denied = await client
      .get('/demo/notes')
      .header('x-tenant-id', a.id)
      .header('x-test-principal-tenant', b.id)
    denied.assertStatus(403)

    // The matching principal passes the gate and reaches the controller.
    const allowed = await client
      .get('/demo/notes')
      .header('x-tenant-id', a.id)
      .header('x-test-principal-tenant', a.id)
    allowed.assertStatus(200)
    allowed.assertBodyContains({ tenantId: a.id })
  })

  test('the gate stays a no-op when no principal header is present', async ({ client }) => {
    // The demo's authorizer returns true when the stand-in header is absent, so the
    // rest of the suite is unaffected. A real app would derive the principal from
    // `auth.user` and never take this branch.
    const a = await createInstalledTenant(client, { plan: 'pro' })

    const r = await client.get('/demo/notes').header('x-tenant-id', a.id)
    r.assertStatus(200)
    r.assertBodyContains({ tenantId: a.id })
  })
})
