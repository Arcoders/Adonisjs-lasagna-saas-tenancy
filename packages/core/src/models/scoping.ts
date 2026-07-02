import { AsyncLocalStorage } from 'node:async_hooks'
import { tenancy } from '../tenancy.js'
import { configuredScopeColumn } from '../services/isolation/rowscope_pg_driver.js'
import { getConfig } from '../config.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { recordScopeBypass } from './scope_bypass_audit.js'

/**
 * Lucid's `BaseModel` (typed loosely so this file doesn't have to import
 * the full ORM type — keeps the mixin tree-shakeable).
 */
type LucidBaseModelClass = new (...args: any[]) => any
type Bootable = LucidBaseModelClass & {
  boot(): void
  booted: boolean
  before(event: string, handler: (...args: any[]) => any): void
}

const bypassStorage = new AsyncLocalStorage<{ bypass: true; audited: boolean }>()

/**
 * Run `fn` with tenant scoping disabled. Inside `fn`, queries against
 * scoped models will not have `where tenant_id = ?` applied automatically.
 *
 * Use this for legitimate cross-tenant operations (admin reports, central
 * migrations, audit log emission). Always prefer scoped queries in user
 * code paths. Pass `{ reason }` to attribute the bypass in the audit trail:
 * every OUTERMOST bypass emits one rate-limited `scope:bypass` audit event
 * (best-effort, never blocks or breaks the operation), so a deliberate or
 * accidental cross-tenant escape is never invisible. This is the
 * escape-hatch-with-an-audit-trail pattern.
 */
export function unscoped<T>(fn: () => T | Promise<T>, opts?: { reason?: string }): Promise<T> {
  const parent = bypassStorage.getStore()
  const alreadyAudited = parent?.audited === true
  return bypassStorage.run({ bypass: true, audited: true }, async () => {
    // Emit exactly one attributed event per outermost bypass. Nested unscoped()
    // calls (and the audit write's own bypass, if any) inherit audited:true and
    // skip, so there is no recursion and no duplicate event.
    if (!alreadyAudited) await recordScopeBypass(opts?.reason)
    return fn()
  })
}

/**
 * True when the current async scope was opened via `unscoped(fn)`.
 */
export function isScopeBypassed(): boolean {
  return bypassStorage.getStore()?.bypass === true
}

/**
 * Whether a scope-less query (no active `tenancy.run()`, no `unscoped(fn)`) is
 * permitted to run globally. Fail-closed: this is true ONLY when the config is
 * readable AND explicitly opts out with `rowScopeMode: 'allowGlobal'`. Every
 * other case — strict (the default) OR an UNREADABLE config (getConfig threw,
 * e.g. the provider hasn't booted) — returns false so the caller throws rather
 * than silently falling through to a cross-tenant global query.
 *
 * The previous version returned false (= strict) from getConfig()'s throw but
 * was consulted as `isStrictScope()`, so an unreadable config actually meant
 * "not strict" → fail-OPEN. Inverting to an explicit allow flag closes that.
 */
function allowsGlobalScope(): boolean {
  try {
    return getConfig().isolation?.rowScopeMode === 'allowGlobal'
  } catch {
    return false
  }
}

/**
 * Thrown when a scoped model is queried without an active tenant context
 * and without `unscoped(fn)`. Indicates a forgotten `tenancy.run()` —
 * wrap the call site in either `tenancy.run(tenant, fn)` (intended) or
 * `unscoped(fn)` (admin/cross-tenant operation).
 */
export class MissingTenantScopeException extends Error {
  constructor(public readonly action: string) {
    super(
      `withTenantScope: ${action} ran outside both tenancy.run() and unscoped(). ` +
        `Strict mode (config.isolation.rowScopeMode = 'strict') refuses to fall ` +
        `through to a global query. Wrap the call site in tenancy.run(tenant, fn) ` +
        `for a tenant operation, or unscoped(fn) for an explicit cross-tenant one.`
    )
    this.name = 'MissingTenantScopeException'
  }
}

/**
 * Mixin that turns a Lucid model into a tenant-scoped one. Applied
 * queries (`find`, `fetch`, `paginate`) get `where tenant_id = <current>`
 * injected automatically; saves auto-fill the column.
 *
 * @example
 *   import { BaseModel, column } from '@adonisjs/lucid/orm'
 *   import { withTenantScope } from '@adonisjs-lasagna/saas-tenancy'
 *
 *   export default class Post extends withTenantScope(BaseModel) {
 *     @column({ isPrimary: true }) declare id: number
 *     @column() declare title: string
 *     // tenant_id is added by the mixin and managed automatically
 *   }
 *
 * Use `unscoped(fn)` to escape the scope for cross-tenant operations.
 *
 * ## SECURITY: top-level `orWhere` can escape the auto-scope
 *
 * The tenant predicate is injected as flat top-level predicates. Because SQL
 * binds `AND` tighter than `OR`, a query that introduces top-level `OR`
 * branches can leave a branch outside the tenant filter and leak rows across
 * tenants:
 *
 *   // UNSAFE — the `featured` branch is not tenant-scoped, so other tenants'
 *   // featured rows leak. Becomes (roughly):
 *   //   WHERE (tenant_id = X AND a = 1) OR featured = true OR (b = 2 AND tenant_id = X)
 *   Post.query().where('a', 1).orWhere('featured', true).orWhere('b', 2)
 *
 * Always GROUP your `OR` branches so the tenant predicate wraps all of them:
 *
 *   // SAFE — WHERE (a = 1 OR featured = true OR b = 2) AND tenant_id = X
 *   Post.query().where((q) => q.where('a', 1).orWhere('featured', true).orWhere('b', 2))
 *
 * Treat any non-grouped top-level `OR` as unsafe. This is a fundamental
 * limitation of injecting a scope through Lucid's query hooks (they run after
 * your clauses are composed, with no way to retroactively group them). For a
 * hard isolation boundary that does not depend on query-author discipline,
 * enable PostgreSQL Row-Level Security on the scoped tables in addition to this
 * mixin: publish the policy migration with `configure --with=rls` and set the
 * tenant per transaction with `withTenantRls()` / `setTenantRlsGuc()`. See
 * docs/guides/data-isolation/rowscope-pg.md.
 */
export function withTenantScope<TBase extends LucidBaseModelClass>(Base: TBase): TBase {
  const Bootable = Base as TBase & Bootable

  abstract class TenantScoped extends Bootable {
    static booted: boolean = false

    static boot(): void {
      // Re-implement Lucid's idempotent boot guard at the mixin layer so
      // the parent's $hooks Map is registered before we add ours.
      if ((this as any).booted === true) return
      super.boot?.()

      const column = configuredScopeColumn()

      const requireScope = (action: string): string | null => {
        if (isScopeBypassed()) return null
        const id = tenancy.currentId()
        if (id) return id
        // No active tenant context: fail closed unless config EXPLICITLY opts
        // out. An unreadable config no longer falls through to a global query.
        if (allowsGlobalScope()) return null
        emitIsthmusEvent('seal.scope_required', { metadata: { action } })
        throw new MissingTenantScopeException(action)
      }

      this.before('find', (query: any) => {
        const id = requireScope('find')
        if (id) query.where(column, id)
      })

      this.before('fetch', (query: any) => {
        const id = requireScope('fetch')
        if (id) query.where(column, id)
      })

      // Lucid's `before:fetch` only fires when knex's `_method === 'select'`,
      // so query-builder DELETE/UPDATE wouldn't get scoped through it.
      // Wrap the static `query()` factory to inject the scope predicate at
      // construction time — that way `Model.query().delete()` and
      // `Model.query().update({...})` inherit the same `where tenant_id = ?`
      // guard as fetches without us having to plumb individual hooks.
      // Guard the wrap so unit tests using a minimal Lucid stub (no static
      // `query`) still boot — only real ORM models wire this path up.
      const originalQuery = (this as any).query
      if (typeof originalQuery === 'function') {
        const bound = originalQuery.bind(this)
        ;(this as any).query = function tenantScopedQuery(...args: any[]) {
          const builder = bound(...args)
          const id = requireScope('query')
          if (id) builder.where(column, id)
          return builder
        }
      }

      this.before('paginate', (queries: any) => {
        const id = requireScope('paginate')
        if (!id) return
        const [counter, fetcher] = Array.isArray(queries) ? queries : [queries, queries]
        counter?.where?.(column, id)
        fetcher?.where?.(column, id)
      })

      this.before('create', (model: any) => {
        const id = requireScope('create')
        if (!id) return
        if (model[column] === undefined || model[column] === null) {
          model[column] = id
          return
        }
        // An explicit tenant id that doesn't match the active context would
        // create a row owned by another tenant. Refuse, consistent with the
        // update/delete hooks below. Wrap the call in unscoped(...) for a
        // deliberate cross-tenant create.
        if (model[column] !== id) {
          emitIsthmusEvent('seal.scope_owner_mismatch', {
            tenantId: id,
            metadata: { action: 'create', rowTenantId: String(model[column]).slice(0, 64) },
          })
          throw new Error(
            `withTenantScope: refusing to create a row owned by tenant "${model[column]}" from tenant "${id}" context. ` +
              `Wrap the operation in unscoped(...) if this is intentional.`
          )
        }
      })

      this.before('update', (model: any) => {
        const id = requireScope('update')
        if (!id) return
        // Do not silently rewrite a different tenant's id; surface the bug.
        if (model[column] !== undefined && model[column] !== id) {
          emitIsthmusEvent('seal.scope_owner_mismatch', {
            tenantId: id,
            metadata: { action: 'update', rowTenantId: String(model[column]).slice(0, 64) },
          })
          throw new Error(
            `withTenantScope: refusing to update a row owned by tenant "${model[column]}" from tenant "${id}" context. ` +
              `Wrap the operation in unscoped(...) if this is intentional.`
          )
        }
      })

      this.before('delete', (model: any) => {
        const id = requireScope('delete')
        if (!id) return
        if (model[column] !== undefined && model[column] !== id) {
          emitIsthmusEvent('seal.scope_owner_mismatch', {
            tenantId: id,
            metadata: { action: 'delete', rowTenantId: String(model[column]).slice(0, 64) },
          })
          throw new Error(
            `withTenantScope: refusing to delete a row owned by tenant "${model[column]}" from tenant "${id}" context. ` +
              `Wrap the operation in unscoped(...) if this is intentional.`
          )
        }
      })
    }
  }

  return TenantScoped as unknown as TBase
}
