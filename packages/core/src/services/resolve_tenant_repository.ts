import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import { assertCoreAccessAllowed } from './plugin_core_access.js'
import type { TenantRepositoryContract, TenantMetadata } from '../types/contracts.js'

/**
 * Resolve the host's tenant repository from the container.
 *
 * The `as any` on the binding key is the one unavoidable cast in the whole
 * package: the container can't infer a return type from a `Symbol` token, and
 * `types/contracts.ts` keeps that symbol in a types-only module on purpose (no
 * runtime imports). Funnelling every lookup through here means the cast lives in
 * exactly one place and callers get a properly typed result instead of repeating
 * `make(TENANT_REPOSITORY as any) as TenantRepositoryContract` at 50+ sites.
 *
 * That ~40-site funnel is also the S5 core-access choke point: because untrusted
 * plugin code has no legitimate reason to reach the cross-tenant repository,
 * `assertCoreAccessAllowed` denies the lookup (and emits `guard.plugin_core_access`)
 * when untrusted plugin code is on the stack. Core and trusted plugins pass through
 * unchanged. Because every one of core's own callers routes through here, the gate
 * covers core's usage cleanly — but it is still only IN-PROCESS FRICTION, not a
 * boundary: `TENANT_REPOSITORY` is a global `Symbol.for`, so a plugin can reconstruct
 * the key and call `container.make` directly, reaching around this gate exactly as a
 * direct db import reaches around `resolveDatabase`. The hard boundary that actually
 * denies an untrusted write is the S3 read-only Postgres role.
 *
 * Pass a request-scoped resolver when you already have one (e.g. an HTTP
 * controller's `ctx.containerResolver`); it defaults to the app container, which
 * is correct for the singleton `TENANT_REPOSITORY` binding.
 */
export async function resolveTenantRepository<TMeta extends object = TenantMetadata>(
  resolver: { make(key: any): Promise<any> } = app.container
): Promise<TenantRepositoryContract<TMeta>> {
  assertCoreAccessAllowed('tenant-repository')
  return (await resolver.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract<TMeta>
}
