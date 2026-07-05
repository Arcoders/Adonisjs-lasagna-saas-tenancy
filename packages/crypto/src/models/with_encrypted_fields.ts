import app from '@adonisjs/core/services/app'
import EncryptedRepository from '../services/encrypted_repository.js'
import {
  collectModelEncryptionMeta,
  decryptModelFields,
  encryptModelFields,
  type EncryptableRow,
  type ModelEncryptionMeta,
} from './encrypted_columns.js'

// The Lucid model instance a lifecycle hook receives: the minimal encryptable-row
// surface plus its constructor (the key the per-model metadata is memoized under).
// Typing the closures to this (instead of `any`) catches an accidental misuse at
// compile time while staying honest about the dynamic Lucid boundary.
type EncryptableModel = EncryptableRow & { readonly constructor: Function }

// Lucid's model class, typed loosely so this mixin does not import the full ORM
// type (mirrors `withTenantScope` in core's scoping.ts).
type LucidBaseModelClass = new (...args: any[]) => any
type BootableModel = LucidBaseModelClass & {
  boot(): void
  booted: boolean
  before(event: string, handler: (...args: any[]) => any): void
  after(event: string, handler: (...args: any[]) => any): void
}

/**
 * The mixin that makes `@encrypted` / `@searchable` columns transparent (crypto
 * §6.4 Option A). Compose it onto whichever base model the host uses:
 *
 * ```ts
 * class Renter extends compose(TenantBaseModel, withEncryptedFields) {
 *   @column({ isPrimary: true }) declare id: string
 *   @encrypted({ category: 'identity-docs', subject: (row) => row.id })
 *   declare passportNumber: string | null
 *   @searchable({ category: 'identity-docs', from: (row) => row.passportNumber })
 *   declare passportNumberIndex: string | null
 * }
 * ```
 *
 * It registers ASYNC Lucid lifecycle hooks (the DEK unwrap is async, which the SYNC
 * `prepare`/`consume` column hooks cannot do): `before('create'|'update')` encrypts
 * + (re)indexes fail-closed (a failure aborts the save), and
 * `after('create'|'update'|'find'|'fetch')` decrypts back to plaintext in memory
 * (fail-closed on a shredded/tampered value, I3/T6). The engine is the container
 * `EncryptedRepository`, resolved at hook time, which resolves the current tenant
 * fail-closed. A model with no encrypted/searchable columns wires no hooks.
 *
 * SCOPE OF THE GUARANTEE (honest limits, I3/T5). These hooks fire only on the model
 * *instance* write/read path: `model.save()`, `Model.create()` / `createMany()`, and
 * loads via `find`/`fetch`/`paginate`. They DO NOT fire for:
 *   - query-builder writes (`Model.query().insert()/.update()`) or raw SQL
 *     (`db.rawQuery('UPDATE ...')`), which store PLAINTEXT in the encrypted column
 *     and skip the blind index (a T5 bypass; the DB-level fail-closed guard the
 *     design promises, `guard.crypto_plaintext_write` / invariant-3, is not built
 *     yet). Route every write to an `@encrypted` column through a model instance.
 *   - the `*Quietly` family (`saveQuietly` / `createQuietly` / `createManyQuietly`),
 *     which Lucid defines as "same as X without invoking hooks": the same plaintext
 *     bypass. Do not use them for encrypted models.
 *   - a preload of a RELATED encrypted model that does not itself compose this mixin
 *     (its ciphertext would surface undecrypted). Compose the mixin on every model
 *     with `@encrypted` columns.
 * After a crypto-shred, the inert ciphertext stays physically present, so a BULK read
 * (`Model.all()` / `.paginate()` / `findMany`) that includes the shredded row throws
 * fail-closed and aborts the whole batch (I3/I6, no per-row isolation by design). The
 * host must null/soft-delete the encrypted column (or filter the row out) on
 * `SubjectShredded`. Each `@encrypted`/`@searchable` field resolves the current tenant
 * per row (no per-batch memo), so a wide list amplifies tenant lookups; back the
 * host `TenantRepository.findById` with a cache. See design §10 (honest bounds).
 */
export function withEncryptedFields<T extends LucidBaseModelClass>(Base: T): T {
  const Bootable = Base as T & BootableModel

  abstract class WithEncryptedFields extends Bootable {
    static booted = false

    static boot(): void {
      // Re-implement Lucid's idempotent boot guard at the mixin layer so the
      // parent's $hooks Map is registered before we add ours (as scoping.ts does).
      if ((this as any).booted === true) return
      super.boot?.()

      // Dedup across mixin LAYERS. Composing `withEncryptedFields` twice (directly,
      // or via a subclass whose ancestor already composed it) produces two boot()
      // closures that both run in a single boot cascade with the same `this`. Without
      // this guard each hook would register twice, so every row would encrypt/decrypt
      // twice, and the second decrypt pass throws (it re-opens already-plaintext).
      // Keyed on the concrete constructor so registration happens at most once per
      // model, no matter how many layers appear in the chain.
      if (HOOKED.has(this)) return
      HOOKED.add(this)

      const repo = (): Promise<EncryptedRepository> => app.container.make(EncryptedRepository)

      // The hooks are registered UNCONDITIONALLY here and resolve the model's
      // encryption metadata at INVOCATION time (memoized). This is deliberate: a
      // `@column`/`@encrypted` decorator calls `Model.boot()` when it is applied, so
      // boot() can run before every `@encrypted`/`@searchable` on the class has been
      // registered. Reading the metadata inside the hook (which fires at save/load,
      // long after all decorators) avoids that race; a model with no encrypted
      // columns simply returns early.
      const encryptHook = async (model: EncryptableModel): Promise<void> => {
        const meta = resolveMeta(model.constructor)
        if (meta.encrypted.length === 0 && meta.searchable.length === 0) return
        await encryptModelFields(await repo(), meta, model)
      }
      const decryptHook = async (model: EncryptableModel): Promise<void> => {
        const meta = resolveMeta(model.constructor)
        if (meta.encrypted.length === 0) return
        await decryptModelFields(await repo(), meta, model)
      }
      const decryptEach = async (models: EncryptableModel[]): Promise<void> => {
        for (const model of models ?? []) await decryptHook(model)
      }

      this.before('create', encryptHook)
      this.before('update', encryptHook)
      this.after('create', decryptHook)
      this.after('update', decryptHook)
      this.after('find', decryptHook)
      // No `after('paginate')`: Lucid's `paginate()` fires `after:fetch` on the same
      // row instances immediately after `after:paginate` (query_builder exec order),
      // so registering both would decrypt every paginated row twice, and the second
      // pass re-opens now-plaintext values and throws. `after('fetch')` alone covers
      // paginated rows exactly once.
      this.after('fetch', decryptEach)
    }
  }

  return WithEncryptedFields as unknown as T
}

// Concrete model constructors whose encrypt/decrypt hooks are already registered, so
// composing the mixin more than once in a chain cannot double-register (see boot()).
const HOOKED = new WeakSet<Function>()

// Per-constructor metadata, resolved lazily at first hook invocation (by then every
// decorator on the class has run) and cached.
const META_CACHE = new WeakMap<Function, ModelEncryptionMeta>()
function resolveMeta(ctor: Function): ModelEncryptionMeta {
  let meta = META_CACHE.get(ctor)
  if (!meta) {
    meta = collectModelEncryptionMeta(ctor)
    META_CACHE.set(ctor, meta)
  }
  return meta
}
