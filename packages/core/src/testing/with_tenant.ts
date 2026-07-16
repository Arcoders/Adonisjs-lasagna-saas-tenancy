import type { HttpRequest } from '@adonisjs/core/http'
import type { TenantModelContract } from '../types/contracts.js'
import { __setMemoizedTenant } from '../extensions/request.js'
import { tenancy } from '../tenancy.js'

/**
 * Seed the per-request tenant memo so `await request.tenant()` returns the
 * provided tenant without going through the resolver or hitting the
 * repository. Use this in tests to skip tenant resolution.
 */
export function setRequestTenant(request: HttpRequest, tenant: TenantModelContract): void {
  __setMemoizedTenant(request, tenant)
}

/**
 * Run `fn` inside an active tenant context, a test-time convenience over
 * `tenancy.run(tenant, fn)`. The bootstrapper registry enters before `fn`
 * and leaves after it (even on throw), and `tenancy.currentId()` reflects
 * the tenant for the duration, so tenant-scoped models and helpers behave
 * exactly as they would under the HTTP guard.
 */
export function withTenant<T>(tenant: TenantModelContract, fn: () => T | Promise<T>): Promise<T> {
  return tenancy.run(tenant, fn)
}
