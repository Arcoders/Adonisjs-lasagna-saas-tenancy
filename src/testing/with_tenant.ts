import type { HttpRequest } from '@adonisjs/core/http'
import type { TenantModelContract } from '../types/contracts.js'
import { __setMemoizedTenant } from '../extensions/request.js'

/**
 * Seed the per-request tenant memo so `await request.tenant()` returns the
 * provided tenant without going through the resolver or hitting the
 * repository. Use this in tests to skip tenant resolution.
 */
export function setRequestTenant(request: HttpRequest, tenant: TenantModelContract): void {
  __setMemoizedTenant(request, tenant)
}
