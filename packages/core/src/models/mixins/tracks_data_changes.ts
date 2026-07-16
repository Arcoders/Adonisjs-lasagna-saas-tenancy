import { tenancy } from '../../tenancy.js'
import type {
  TenantDataChangeOperation,
  TenantDataChangePayload,
} from '../../events/tenant_data_changed.js'

/**
 * Opt-in mixin that makes a tenant model EMIT a {@link TenantDataChanged}
 * event after each committed row mutation, so plugins (search, analytics, realtime)
 * can react to writes without the model importing them. It is OFF by default:
 * `TenantBaseModel` stays untouched; only a model wrapped in `TracksDataChanges`
 * emits.
 *
 *   export default class Order extends TracksDataChanges(TenantBaseModel) { ... }
 *
 * Guarantees:
 *  - **Isolation by construction.** The payload names WHAT changed (model class,
 *    table, primary key, changed column names), never the column VALUES, and is
 *    attributed to `tenancy.currentId()`. If there is no active tenant scope the
 *    change is SKIPPED, never emitted mis-attributed. (`keys` carries the primary
 *    key's VALUE; that is safe for a surrogate key, but a model with a natural PK
 *    (an email/slug) would put that value in the payload.)
 *  - **After-commit.** The dispatch is deferred to `model.$trx`'s `commit`, so a
 *    write that ROLLS BACK emits nothing. An autocommit write (no `$trx`) dispatches
 *    inline (it has already committed). CAVEAT: a NESTED transaction (a savepoint)
 *    that commits before its outer transaction rolls back can still emit. The
 *    rollback guarantee is absolute only for a top-level transaction.
 *  - **Fail-open.** The emit is fire-and-forget and guarded, so a downed subscriber
 *    or emitter never breaks (or slows) the write; a failure is logged, not swallowed.
 *
 * COVERAGE: only INSTANCE writes fire this: `model.save()` / `Model.create()` /
 * `model.delete()`. A query-builder BULK mutation (`Model.query().update({...})` /
 * `.delete()`) bypasses Lucid's per-instance hooks entirely and emits NOTHING, so a
 * subscriber relying on this for cache/search invalidation must mirror bulk writes
 * itself. (Same Lucid limitation `models/scoping.ts` documents for its scope hooks.)
 *
 * Mirrors `models/scoping.ts`: the same loosely-typed Lucid surface and the same
 * idempotent `static boot()` guard, so this file stays tree-shakeable and importable
 * without a booted app.
 */

type LucidBaseModelClass = new (...args: any[]) => any
type Bootable = LucidBaseModelClass & {
  boot(): void
  booted: boolean
  before(event: string, handler: (...args: any[]) => any): void
  after(event: string, handler: (...args: any[]) => any): void
}

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

// The column names that were dirty just before an update, captured in the
// `before('update')` hook (Lucid clears `$dirty` once the row persists, so the
// `after('update')` hook can no longer read them). A WeakMap so a model instance
// never has to carry a bookkeeping property and entries GC with the model.
const pendingUpdateColumns = new WeakMap<object, string[]>()

/**
 * The dispatch sink, swappable for tests. Defaults to dispatching the real
 * AdonisJS event; a unit test overrides it to capture payloads without a booted
 * emitter. Lazy-imports the event so this module stays app.booted-safe.
 */
let dispatchDataChange: (payload: TenantDataChangePayload) => unknown | Promise<unknown> = async (
  payload
) => {
  const { default: TenantDataChanged } = await import('../../events/tenant_data_changed.js')
  return TenantDataChanged.dispatch(payload)
}

/**
 * Test seam: override the data-change dispatcher. Returns a restore function.
 * @internal swaps a process-wide sink; not re-exported from the `/mixins` barrel.
 */
export function __setDataChangeDispatcherForTests(
  fn: (payload: TenantDataChangePayload) => unknown | Promise<unknown>
): () => void {
  const previous = dispatchDataChange
  dispatchDataChange = fn
  return () => {
    dispatchDataChange = previous
  }
}

/** Read a static off the model class without importing the full ORM types. */
function modelMeta(model: any): { name: string; table: string; primaryKey: string } {
  const ctor = model?.constructor ?? {}
  return {
    name: typeof ctor.name === 'string' ? ctor.name : 'Unknown',
    table: typeof ctor.table === 'string' ? ctor.table : '',
    primaryKey: typeof ctor.primaryKey === 'string' ? ctor.primaryKey : 'id',
  }
}

/** Fire-and-forget, guarded emit that never throws into the caller (the write path). */
function safeEmit(payload: TenantDataChangePayload): void {
  const onFail = (err: unknown) =>
    void lazyLogger().then((l) =>
      l?.error(
        {
          tenantId: payload.tenantId,
          model: payload.model,
          operation: payload.operation,
          err: (err as Error)?.message,
        },
        'data-change emit failed; continuing (fail-open)'
      )
    )
  try {
    const result = dispatchDataChange(payload)
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      ;(result as Promise<unknown>).catch(onFail)
    }
  } catch (err) {
    onFail(err)
  }
}

/**
 * Build the change and emit it after commit (or inline on autocommit). Skips when
 * there is no active tenant scope: a change must never be emitted mis-attributed.
 */
function trackChange(model: any, operation: TenantDataChangeOperation, columns?: string[]): void {
  const tenantId = tenancy.currentId()
  if (!tenantId) return

  const { name, table, primaryKey } = modelMeta(model)
  const payload: TenantDataChangePayload = {
    tenantId,
    model: name,
    table,
    operation,
    keys: { [primaryKey]: model?.[primaryKey] },
    ...(columns && columns.length > 0 ? { columns } : {}),
  }

  // Defer to commit so a rolled-back write emits nothing; dispatch inline when the
  // write was autocommitted (no transaction to hang the callback on).
  const trx = model?.$trx
  if (trx && typeof trx.after === 'function') {
    trx.after('commit', () => safeEmit(payload))
  } else {
    safeEmit(payload)
  }
}

export function TracksDataChanges<TBase extends LucidBaseModelClass>(Base: TBase): TBase {
  const Bootable = Base as TBase & Bootable

  abstract class TracksChanges extends Bootable {
    static booted: boolean = false

    static boot(): void {
      // Idempotent boot guard at the mixin layer (mirrors withTenantScope) so the
      // parent's $hooks Map exists before we register ours.
      if ((this as any).booted === true) return
      super.boot?.()

      // Capture the changed column NAMES before the update persists: Lucid clears
      // `$dirty` once the row is saved, so the after-hook cannot read them.
      this.before('update', (model: any) => {
        const dirty = model?.$dirty
        if (dirty && typeof dirty === 'object') {
          pendingUpdateColumns.set(model, Object.keys(dirty))
        }
      })

      this.after('create', (model: any) => trackChange(model, 'create'))
      this.after('update', (model: any) => {
        const columns = pendingUpdateColumns.get(model)
        pendingUpdateColumns.delete(model)
        trackChange(model, 'update', columns)
      })
      this.after('delete', (model: any) => trackChange(model, 'delete'))
    }
  }

  return TracksChanges as unknown as TBase
}
