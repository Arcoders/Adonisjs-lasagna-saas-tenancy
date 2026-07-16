import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '../types/contracts.js'
import { buildTestTenant, type BuildTestTenantOverrides } from './builders.js'

export interface TestAuthzContextOptions {
  /** Value placed on `ctx.auth.user` (the common `@adonisjs/auth` shape). */
  user?: Record<string, unknown> | null
  /** Request headers the authorizer may read via `ctx.request.header(name)`. */
  headers?: Record<string, string>
  /** Overrides forwarded to `buildTestTenant`; the `id` is fixed to `tenantId`. */
  tenant?: Omit<BuildTestTenantOverrides, 'id'>
}

/**
 * Build a minimal `{ ctx, tenant }` pair for unit-testing an
 * `authorizeTenantAccess` hook without booting an app or hand-mocking a full
 * `HttpContext`. It models the two axes the package's own examples use: the
 * authenticated principal on `ctx.auth.user` and request headers via
 * `ctx.request.header(name)`. A hook that reads the request body or query string
 * should construct its own context; those are out of scope here.
 *
 * @example // auth-based membership check
 *   const { ctx, tenant } = createTestAuthzContext('tid', { user: { tenantId: 'tid' } })
 *   const authorize = (c, t) => c.auth?.user?.tenantId === t.id
 *   assert.isTrue(await authorize(ctx, tenant))
 *
 * @example // header-based membership check
 *   const { ctx, tenant } = createTestAuthzContext('tid', { headers: { 'x-tenant': 'tid' } })
 *   const authorize = (c, t) => c.request.header('x-tenant') === t.id
 */
export function createTestAuthzContext(
  tenantId: string,
  options: TestAuthzContextOptions = {}
): { ctx: HttpContext; tenant: TenantModelContract } {
  const tenant = buildTestTenant({ ...options.tenant, id: tenantId })
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }
  const ctx = {
    auth: { user: options.user ?? null },
    request: {
      tenant: async () => tenant,
      header: (name: string) => headers[name.toLowerCase()] ?? null,
      url: () => '/',
    },
  } as unknown as HttpContext
  return { ctx, tenant }
}
