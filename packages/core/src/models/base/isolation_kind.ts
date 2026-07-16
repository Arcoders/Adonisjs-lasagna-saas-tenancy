import type { LucidModel } from '@adonisjs/lucid/types/model'

/**
 * Where a model's rows live, declared on the model rather than inferred from
 * which base class it extends:
 *   - `tenant`:     per-tenant storage, routed by the active `IsolationDriver`
 *   - `backoffice`: the shared backoffice schema (satellite / cross-tenant data)
 *   - `central`:    the central/default connection (the tenants registry itself)
 *
 * `TenantBaseModel` / `BackofficeBaseModel` / `CentralBaseModel` are thin shims
 * that just set `static isolation` to one of these; the unified `TenantAdapter`
 * reads it. A host model can declare the marker directly instead of being locked
 * into the inheritance hierarchy.
 */
export type IsolationKind = 'tenant' | 'backoffice' | 'central'

/**
 * Read the declarative `static isolation` marker off a model constructor,
 * defaulting to `tenant` so an unmarked model behaves like the historical
 * tenant-routed default.
 */
export function resolveIsolationKind(modelConstructor: LucidModel): IsolationKind {
  const declared = (modelConstructor as unknown as { isolation?: IsolationKind })?.isolation
  return declared ?? 'tenant'
}
