import { column as lucidColumn } from '@adonisjs/lucid/orm'
import type { BlindIndexOptions } from '../internal/blind_index.js'
import type { CategoryKey, SubjectId } from '../types/key_provider.js'

/**
 * The transparent field-encryption surface (crypto §6.4, Option A). `@encrypted`
 * and `@searchable` are Lucid property decorators: they register the field as a
 * column AND record how it maps to a `(subject × category)` DEK / a blind index.
 * The actual encrypt/decrypt/index work runs in ASYNC model lifecycle hooks (the
 * DEK unwrap is async, which Lucid's SYNC `prepare`/`consume` column hooks cannot
 * do), wired by the {@link withEncryptedFields} mixin. Both surfaces are backstopped
 * by the same invariants as the {@link EncryptedRepository} (I3 fail-closed, I5
 * keyed blind index); the decorator only makes forgetting to encrypt impossible for
 * a declared column.
 *
 * The decorators only RECORD metadata here; nothing touches the container or a DEK
 * at decoration time, so this module is import-safe in a bare unit runner. The pure
 * `encryptModelFields`/`decryptModelFields` take an injected repo, so they are
 * unit-testable without an app; the mixin resolves the real repo from the container.
 */

/** How an `@encrypted` column maps to its per-`(subject × category)` DEK. */
export interface EncryptedColumnMeta {
  readonly column: string
  readonly category: CategoryKey
  /** Resolve the data-subject id from the row (e.g. `(row) => row.id`). */
  readonly subject: (row: any) => SubjectId
}

/** How a `@searchable` column derives its keyed-HMAC blind index. */
export interface SearchableColumnMeta {
  readonly column: string
  readonly category: CategoryKey
  /** Resolve the PLAINTEXT source to index from the row (e.g. `(row) => row.passportNumber`). */
  readonly from: (row: any) => string | null | undefined
  readonly options: BlindIndexOptions
}

export interface ModelEncryptionMeta {
  readonly encrypted: EncryptedColumnMeta[]
  readonly searchable: SearchableColumnMeta[]
}

/**
 * The minimal encryption surface the hooks need, injected so the pure functions are
 * unit-testable. {@link EncryptedRepository} satisfies it (the mixin resolves that
 * singleton, which resolves the current tenant fail-closed).
 */
export interface EncryptedFieldsRepo {
  encrypt(subject: SubjectId, category: CategoryKey, value: string): Promise<string>
  decrypt(subject: SubjectId, category: CategoryKey, ciphertext: string): Promise<string>
  blindIndex(category: CategoryKey, value: string, options?: BlindIndexOptions): Promise<string>
}

// Per-model metadata, keyed by the exact model constructor so a subclass never
// inherits a parent's encrypted columns by accident (the mixin walks the chain to
// merge deliberately, below).
const REGISTRY = new WeakMap<
  Function,
  { encrypted: EncryptedColumnMeta[]; searchable: SearchableColumnMeta[] }
>()

function slot(ctor: Function) {
  let entry = REGISTRY.get(ctor)
  if (!entry) {
    entry = { encrypted: [], searchable: [] }
    REGISTRY.set(ctor, entry)
  }
  return entry
}

export interface EncryptedOptions {
  /** The governance category whose per-`(subject × category)` DEK seals this field. */
  category: CategoryKey
  /** Resolve the data-subject id from the row (e.g. `(row) => row.id`). */
  subject: (row: any) => SubjectId
}

/**
 * Mark a Lucid column as transparently encrypted at rest under its `(subject ×
 * category)` DEK (I1). It IS the column (there is no sibling plaintext column, I1):
 * the value on disk is `enc_v2` ciphertext, decrypted on read and encrypted on
 * write by the {@link withEncryptedFields} hooks. Use INSTEAD of `@column()`.
 */
export function encrypted(options: EncryptedOptions): PropertyDecorator {
  return (target, propertyKey) => {
    lucidColumn()(target, propertyKey)
    slot(target.constructor).encrypted.push({
      column: String(propertyKey),
      category: options.category,
      subject: options.subject,
    })
  }
}

export interface SearchableOptions {
  /** The category whose KeyProvider index key keys this column's HMAC. */
  category: CategoryKey
  /** Resolve the PLAINTEXT value to index from the row (e.g. `(row) => row.passportNumber`). */
  from: (row: any) => string | null | undefined
  /** Case-fold before hashing (opt-in; see {@link BlindIndexOptions}). */
  caseInsensitive?: boolean
}

/**
 * Mark a Lucid column as a deterministic keyed-HMAC blind index over another
 * field's plaintext (§6.5, I5), so equality search survives encryption. The host
 * queries `Model.query().where('<indexColumn>', await repo.blindIndex(...))`. The
 * column is hidden from serialization by default (`serializeAs: null`): the HMAC
 * reveals equality/frequency (the documented I5 leak), so it should not land in an
 * API response unless the host opts in. Use INSTEAD of `@column()`.
 */
export function searchable(options: SearchableOptions): PropertyDecorator {
  return (target, propertyKey) => {
    lucidColumn({ serializeAs: null })(target, propertyKey)
    slot(target.constructor).searchable.push({
      column: String(propertyKey),
      category: options.category,
      from: options.from,
      options: { caseInsensitive: options.caseInsensitive },
    })
  }
}

/**
 * Merge the encrypted/searchable metadata declared on `ctor` and all its ancestors
 * (so a base model can declare shared encrypted columns and a subclass add more).
 * A column declared on a subclass wins over the same name on an ancestor.
 */
export function collectModelEncryptionMeta(ctor: Function): ModelEncryptionMeta {
  const encryptedByColumn = new Map<string, EncryptedColumnMeta>()
  const searchableByColumn = new Map<string, SearchableColumnMeta>()
  const chain: Function[] = []
  for (let c: Function | null = ctor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    chain.push(c)
  }
  // Walk ancestors first so a subclass declaration overrides a parent's.
  for (const c of chain.reverse()) {
    const entry = REGISTRY.get(c)
    if (!entry) continue
    for (const m of entry.encrypted) encryptedByColumn.set(m.column, m)
    for (const m of entry.searchable) searchableByColumn.set(m.column, m)
  }
  return {
    encrypted: [...encryptedByColumn.values()],
    searchable: [...searchableByColumn.values()],
  }
}

/** A minimal Lucid row surface the hooks read/write (so the pure functions are testable). */
export interface EncryptableRow {
  readonly $attributes: Record<string, unknown>
  $setAttribute(key: string, value: unknown): void
  $hydrateOriginals(): void
}

/** True if a stored value is already Lasagna ciphertext (defends against double-encryption). */
function isCiphertext(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('enc_v2:') || value.startsWith('enc_v1:'))
}

/**
 * Encrypt a model's `@encrypted` columns and (re)compute its `@searchable` indexes,
 * IN PLACE, before an INSERT/UPDATE. Fail-closed (I3/T5): if any field cannot be
 * encrypted (no tenant scope, KeyProvider down) this THROWS, and because it runs in
 * a `before('create'|'update')` hook the whole save aborts, so cleartext is never
 * written. The searchable indexes are computed FIRST, from the still-plaintext
 * source, before the source column is replaced with ciphertext.
 */
export async function encryptModelFields(
  repo: EncryptedFieldsRepo,
  meta: ModelEncryptionMeta,
  model: EncryptableRow
): Promise<void> {
  for (const s of meta.searchable) {
    const source = s.from(model)
    model.$setAttribute(
      s.column,
      source === null || source === undefined
        ? null
        : await repo.blindIndex(s.category, String(source), s.options)
    )
  }
  for (const f of meta.encrypted) {
    const value = model.$attributes[f.column]
    if (value === null || value === undefined) continue
    if (isCiphertext(value)) continue
    model.$setAttribute(f.column, await repo.encrypt(f.subject(model), f.category, String(value)))
  }
}

/**
 * Decrypt a model's `@encrypted` columns IN PLACE after a load (or a write), then
 * re-baseline so the decrypted plaintext is NOT seen as dirty (`$hydrateOriginals`),
 * so a later `save()` re-encrypts only genuinely changed fields. Fail-closed (I3/T6):
 * a shredded DEK, a non-`enc_v2` value, or a tamper THROWS rather than surfacing the
 * ciphertext as if it were plaintext. `@searchable` index columns are left as-is
 * (they are plain HMACs, never decrypted).
 */
export async function decryptModelFields(
  repo: EncryptedFieldsRepo,
  meta: ModelEncryptionMeta,
  model: EncryptableRow
): Promise<void> {
  for (const f of meta.encrypted) {
    const value = model.$attributes[f.column]
    if (value === null || value === undefined) continue
    model.$setAttribute(f.column, await repo.decrypt(f.subject(model), f.category, String(value)))
  }
  model.$hydrateOriginals()
}
