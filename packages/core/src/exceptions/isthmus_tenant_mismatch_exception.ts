import { Exception } from '@adonisjs/core/exceptions'

/**
 * AdonisJS exception thrown by the Isthmus ContextSeal (`TenantAdapter`) when the
 * active `tenancy.run()` scope and the HTTP request resolve DIFFERENT tenants for
 * the same model query. Routing the query would execute tenant A's work under
 * tenant B's context (invariant I1), so the adapter fails closed with HTTP 500 and
 * the code `E_ISTHMUS_TENANT_MISMATCH` instead. The message carries only the two
 * tenant ids.
 *
 * Deliberate cross-tenant work has two sanctioned escapes that never trip this
 * seal: dispatch a job (no HTTP context), or pass an explicit `connection`/`client`
 * query option (checked before tenant resolution).
 */
export default class IsthmusTenantMismatchException extends Exception {
  static readonly status = 500
  static readonly code = 'E_ISTHMUS_TENANT_MISMATCH'

  constructor(tenancyScopeId: string, requestResolvedId: string) {
    super(
      `Tenant context mismatch: the active tenancy scope resolves "${tenancyScopeId}" but the ` +
        `request resolves "${requestResolvedId}". Refusing to route the query. Deliberate ` +
        `cross-tenant work belongs in a job (tenancy.run) or an explicit { connection } option.`,
      {
        status: IsthmusTenantMismatchException.status,
        code: IsthmusTenantMismatchException.code,
      }
    )
  }
}
