import { BaseEvent } from '@adonisjs/core/events'

/** The three row mutations a {@link TracksDataChanges} model reports. */
export type TenantDataChangeOperation = 'create' | 'update' | 'delete'

/**
 * What a data-change carries — it names WHAT changed (the model, its table, the
 * operation, the primary key, and for an update the changed COLUMN NAMES), never the
 * column values. A subscriber that needs the new values re-enters
 * `tenancy.run(tenantId)` and re-reads the row, so tenant isolation is preserved by
 * construction. The payload is safe to log/queue for a surrogate-key model; a model
 * with a natural primary key (email/slug) puts that key value in `keys`.
 */
export interface TenantDataChangePayload {
  /** The tenant the change happened under (from `tenancy.currentId()`). */
  readonly tenantId: string
  /** The Lucid model CLASS NAME (e.g. `Order`). Note: a minified/bundled build
   *  mangles class names — filter on {@link table} instead when you bundle. */
  readonly model: string
  /** The database table the model maps to (stable under minification). */
  readonly table: string
  /** Which mutation occurred. */
  readonly operation: TenantDataChangeOperation
  /** The row's primary key (column → value). */
  readonly keys: Readonly<Record<string, unknown>>
  /** For an update, the NAMES of the columns that changed (never their values). */
  readonly columns?: readonly string[]
}

/**
 * One `definePlugin({ onDataChange })` subscription. Filters are optional and
 * AND-combined: omit `models`/`operations` to receive every change. `handle` runs
 * decoupled from the write (after-commit, fail-open), so a slow/failing subscriber
 * never blocks or rolls back the tenant's write.
 */
export interface TenantDataChangeSubscription {
  /** Only receive changes for these model class names. Omit for all. */
  readonly models?: readonly string[]
  /** Only receive these operations. Omit for all. */
  readonly operations?: readonly TenantDataChangeOperation[]
  /** The handler, run after the write commits, isolated from it. */
  readonly handle: (change: TenantDataChangePayload) => void | Promise<void>
}

/**
 * AdonisJS event emitted AFTER a `TracksDataChanges` model's write COMMITS (SEAM-5).
 * A write that rolls back emits nothing. Subscribe through the standard emitter, or
 * declaratively via `definePlugin({ onDataChange })`.
 *
 * @example
 *   emitter.on(TenantDataChanged, (e) => console.log(e.change.model, e.change.operation))
 */
export default class TenantDataChanged extends BaseEvent {
  constructor(readonly change: TenantDataChangePayload) {
    super()
  }
}
