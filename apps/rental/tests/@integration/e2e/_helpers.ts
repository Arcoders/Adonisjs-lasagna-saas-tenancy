import type { ApiClient } from '@japa/api-client'
import Tenant from '#app/models/backoffice/tenant'
import { DEMO_TENANT_OWNER } from '#app/helpers/rental_credentials'

/**
 * Shared e2e helpers. The suite runs against the already-seeded companies
 * (`rental:seed` + `rental:seed:demo`), so these resolve the demo companies by
 * their vanity host and mint a staff token for each.
 *
 * Two facts drive how requests are addressed:
 *  - The api-client hits the server on `127.0.0.1`, so the domain resolver never
 *    matches; the tenant is selected by the `x-tenant-id` header instead. Every
 *    tenant-scoped request below carries it (see {@link asStaff}).
 *  - Login is rate-limited (10/60s) and so is the AI gateway, so the tokens are
 *    minted ONCE per process and cached; every spec reuses them.
 */
export interface Realm {
  /** The tenant UUID (the `x-tenant-id` header value + the token's home schema). */
  id: string
  /** A `tnt_` staff bearer token minted in this company's own schema. */
  token: string
}

let cache: { acme: Realm; sahara: Realm } | undefined

async function idForSlug(slug: string): Promise<string> {
  const tenant = await Tenant.query().where('custom_domain', `${slug}.localhost`).firstOrFail()
  return tenant.id
}

async function login(client: ApiClient, tenantId: string): Promise<string> {
  const res = await client
    .post('/auth/login')
    .header('x-tenant-id', tenantId)
    .json({ email: DEMO_TENANT_OWNER.email, password: DEMO_TENANT_OWNER.password })
  res.assertStatus(200)
  return res.body().token as string
}

/** The two demo companies with a staff token each, resolved + cached once. */
export async function realms(client: ApiClient): Promise<{ acme: Realm; sahara: Realm }> {
  if (!cache) {
    const [acmeId, saharaId] = await Promise.all([idForSlug('acme'), idForSlug('sahara-cars')])
    cache = {
      acme: { id: acmeId, token: await login(client, acmeId) },
      sahara: { id: saharaId, token: await login(client, saharaId) },
    }
  }
  return cache
}

/**
 * Address a request to a company as authenticated staff: the `x-tenant-id`
 * header selects the schema and the bearer token proves membership. Returns the
 * request so the caller can chain `.json()`, `.get()` body assertions, etc.
 */
export function authHeaders(realm: Realm): { 'x-tenant-id': string; 'authorization': string } {
  return { 'x-tenant-id': realm.id, 'authorization': `Bearer ${realm.token}` }
}
