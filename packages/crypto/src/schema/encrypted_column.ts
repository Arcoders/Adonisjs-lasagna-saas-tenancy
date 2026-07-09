/**
 * The DB-level fail-closed backstop for T5 / I3 (crypto §4 I3, §5 invariant-3): a
 * Postgres CHECK constraint that refuses any non-ciphertext value written to an
 * `@encrypted` column, AT THE DATABASE LAYER. This is the only enforcement that
 * catches the write paths the {@link withEncryptedFields} model hooks cannot:
 *
 *   - raw SQL (`db.rawQuery("UPDATE renters SET passport_number = 'AB123' ...")`),
 *   - query-builder writes (`Model.query().update({ passport_number: 'AB123' })`),
 *   - the `*Quietly` family (`saveQuietly` / `createQuietly`), which Lucid runs
 *     "without invoking hooks".
 *
 * A Lucid `prepare` column hook would catch the `*Quietly` + direct-attribute cases
 * but NOT raw SQL; only a database constraint covers every path. So this closes T5
 * ("write a field marked encrypted as cleartext") where the decorator alone cannot.
 *
 * The constraint is `<col> IS NULL OR left(<col>, N) IN ('enc_v2:', 'enc_v1:')`: an
 * encrypted field value is always core's `enc_v2:<keyId>:<iv>:<tag>:<cipher>` frame
 * (sealed under the DEK by `sealV2WithKey`, a format FIXED regardless of which
 * KeyProvider is bound), the legacy `enc_v1:` frame during an APP_KEY migration, or
 * NULL. A plaintext write matches none of the prefixes, fails the CHECK, and the
 * INSERT/UPDATE is rejected by Postgres.
 *
 * A host adds it in its own model migration, alongside (or after) the encrypted
 * column:
 *
 * ```ts
 * import { encryptedColumnCheckSql } from '@adonisjs-lasagna/crypto'
 *
 * export default class extends BaseSchema {
 *   async up() {
 *     this.schema.createTable('renters', (t) => {
 *       t.uuid('id').primary()
 *       t.text('passport_number')       // holds enc_v2 ciphertext
 *       t.text('passport_number_index') // holds the blind-index HMAC
 *     })
 *     this.schema.raw(encryptedColumnCheckSql('renters', 'passport_number'))
 *   }
 * }
 * ```
 *
 * The constraint is NOT for the `@searchable` blind-index column (a keyed HMAC, hex,
 * not an enc_v2 frame) and NOT for the `wrapped_dek` column: a `wrapped_dek` value is
 * the KeyProvider's own wrap output (an `enc_v2:` frame under the env provider, but an
 * opaque KMS / HashiCorp Vault blob under a real provider), so it has no
 * provider-independent prefix and is deliberately not constrained here (I2 covers the
 * wrapped-DEK column via `check-crypto-invariant-2`).
 */

/**
 * The accepted at-rest ciphertext frame prefixes for an encrypted field. `enc_v2:`
 * is the current core envelope; `enc_v1:` is the legacy frame that core's
 * `tenant:secrets:reencrypt` migrates forward, kept accepted so an in-flight APP_KEY
 * migration does not trip the CHECK. Every prefix is the same byte length (the
 * constraint slices exactly that many leading characters).
 */
export const CIPHERTEXT_PREFIXES = ['enc_v2:', 'enc_v1:'] as const

/** All accepted prefixes share one length; the CHECK slices exactly this many chars. */
const PREFIX_LEN = CIPHERTEXT_PREFIXES[0].length

// Enforced at module load: a future prefix of a different length would silently
// weaken the CHECK (`left(col, N)` would never equal it), so refuse to ship one.
for (const prefix of CIPHERTEXT_PREFIXES) {
  if (prefix.length !== PREFIX_LEN) {
    throw new Error(
      `[crypto] every ciphertext prefix must be ${PREFIX_LEN} chars (the CHECK slices a fixed length); '${prefix}' is ${prefix.length}.`
    )
  }
}

// A snake_case SQL identifier. The table/column become DDL identifiers, so validating
// them here (rather than quoting-and-hoping) keeps the emitted SQL injection-free even
// though the inputs are host migration code, not request data.
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function assertIdentifier(kind: string, value: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `[crypto] invalid ${kind} '${value}': an encrypted-column CHECK identifier must be snake_case (${SQL_IDENTIFIER}).`
    )
  }
}

/** The deterministic constraint name for the ciphertext CHECK on `table.column`. */
export function encryptedColumnCheckName(table: string, column: string): string {
  assertIdentifier('table', table)
  assertIdentifier('column', column)
  return `${table}_${column}_is_ciphertext`
}

/**
 * The bare CHECK predicate for `column` (for a host that prefers Lucid's
 * `table.check(predicate, undefined, name)` over a raw `ALTER TABLE`). A NULL passes
 * (an empty encrypted field is allowed); any non-NULL value must begin with an
 * accepted ciphertext prefix.
 */
export function encryptedColumnCheckPredicate(column: string): string {
  assertIdentifier('column', column)
  const prefixes = CIPHERTEXT_PREFIXES.map((p) => `'${p}'`).join(', ')
  return `"${column}" IS NULL OR left("${column}", ${PREFIX_LEN}) IN (${prefixes})`
}

/** Options for {@link encryptedColumnCheckSql}. */
export interface EncryptedColumnCheckOptions {
  /**
   * Override the constraint name. Postgres truncates identifiers at 63 bytes, so a
   * very long `<table>_<column>_is_ciphertext` would truncate (and risk a collision);
   * pass an explicit short name in that case.
   */
  readonly constraintName?: string
}

/**
 * Build the `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statement that enforces,
 * at the database layer, that `table.column` only ever stores `enc_v2:` / `enc_v1:`
 * ciphertext (or NULL). Drop it into a migration via `this.schema.raw(...)`. This is
 * the T5 / I3 fail-closed backstop for every write path, including the raw-SQL and
 * query-builder bypasses the model hooks cannot see (see the module header).
 */
export function encryptedColumnCheckSql(
  table: string,
  column: string,
  options: EncryptedColumnCheckOptions = {}
): string {
  // `table` is interpolated directly below, so validate it UNCONDITIONALLY: when a
  // caller overrides `constraintName`, the `??` short-circuits encryptedColumnCheckName
  // (the only other place `table` is checked), so leaning on it would skip the guard.
  assertIdentifier('table', table)
  const name = options.constraintName ?? encryptedColumnCheckName(table, column)
  assertIdentifier('constraint name', name)
  // `column` is validated inside encryptedColumnCheckPredicate.
  return `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${encryptedColumnCheckPredicate(column)})`
}
