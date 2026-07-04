import app from '@adonisjs/core/services/app'
import EncryptedRepository from '../services/encrypted_repository.js'
import {
  collectModelEncryptionMeta,
  decryptModelFields,
  encryptModelFields,
  type ModelEncryptionMeta,
} from './encrypted_columns.js'

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
 * + (re)indexes fail-closed (a failure aborts the save, so cleartext is never
 * written, I3/T5), and `after('create'|'update'|'find'|'fetch'|'paginate')` decrypts
 * back to plaintext in memory (fail-closed on a shredded/tampered value, I3/T6). The
 * engine is the container `EncryptedRepository`, resolved at hook time, which
 * resolves the current tenant fail-closed. A model with no encrypted/searchable
 * columns wires no hooks.
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

      const repo = (): Promise<EncryptedRepository> => app.container.make(EncryptedRepository)

      // The hooks are registered UNCONDITIONALLY here and resolve the model's
      // encryption metadata at INVOCATION time (memoized). This is deliberate: a
      // `@column`/`@encrypted` decorator calls `Model.boot()` when it is applied, so
      // boot() can run before every `@encrypted`/`@searchable` on the class has been
      // registered. Reading the metadata inside the hook (which fires at save/load,
      // long after all decorators) avoids that race; a model with no encrypted
      // columns simply returns early.
      const encryptHook = async (model: any): Promise<void> => {
        const meta = resolveMeta(model.constructor)
        if (meta.encrypted.length === 0 && meta.searchable.length === 0) return
        await encryptModelFields(await repo(), meta, model)
      }
      const decryptHook = async (model: any): Promise<void> => {
        const meta = resolveMeta(model.constructor)
        if (meta.encrypted.length === 0) return
        await decryptModelFields(await repo(), meta, model)
      }
      const decryptEach = async (models: any[]): Promise<void> => {
        for (const model of models ?? []) await decryptHook(model)
      }

      this.before('create', encryptHook)
      this.before('update', encryptHook)
      this.after('create', decryptHook)
      this.after('update', decryptHook)
      this.after('find', decryptHook)
      this.after('fetch', decryptEach)
      this.after('paginate', async (paginator: any) => {
        await decryptEach(typeof paginator?.all === 'function' ? paginator.all() : [])
      })
    }
  }

  return WithEncryptedFields as unknown as T
}

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
