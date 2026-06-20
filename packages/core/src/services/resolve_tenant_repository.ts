import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
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
 * Pass a request-scoped resolver when you already have one (e.g. an HTTP
 * controller's `ctx.containerResolver`); it defaults to the app container, which
 * is correct for the singleton `TENANT_REPOSITORY` binding.
 */
export async function resolveTenantRepository<TMeta extends object = TenantMetadata>(
  resolver: { make(key: any): Promise<any> } = app.container
): Promise<TenantRepositoryContract<TMeta>> {
  return (await resolver.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract<TMeta>
}
