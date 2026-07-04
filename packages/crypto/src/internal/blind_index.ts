import { createHmac } from 'node:crypto'

/**
 * Options for the deterministic blind index (crypto §6.5). The core normalization
 * (NFKC + trim) is fixed so two encodings of one value collide; case-folding is
 * opt-in because it is field-dependent (a passport number folds case, a
 * case-sensitive token does not).
 */
export interface BlindIndexOptions {
  /**
   * Case-fold the value before hashing so `'ab12'` and `'AB12'` index equally.
   * Opt-in per field (default false): the host declares it deliberately, matching
   * "NFKC + case-fold where the field semantics allow" (§6.5). Uses locale-
   * independent `toUpperCase()` so the fold is deterministic across environments.
   */
  caseInsensitive?: boolean
}

/**
 * The PINNED blind-index normalization (§6.5). NFKC folds compatibility encodings
 * (so two Unicode spellings of one identifier collide), `trim` removes surrounding
 * whitespace, and the opt-in uppercase fold makes the index case-insensitive. This
 * function is FROZEN: changing it re-derives every host index column and breaks
 * equality against already-stored indexes (it would be an `enc_v3`-grade break).
 */
export function normalizeForBlindIndex(value: string, options: BlindIndexOptions = {}): string {
  const normalized = value.normalize('NFKC').trim()
  return options.caseInsensitive ? normalized.toUpperCase() : normalized
}

/**
 * Compute the deterministic blind index: a KEYED HMAC-SHA256 over the normalized
 * value (§6.5, I5). It is a keyed HMAC via {@link createHmac}, NEVER a bare
 * `createHash` of a salt+value: a low-entropy identifier (a passport number) is a
 * few million candidates, so an unkeyed hash is trivially brute-forced from a DB
 * dump (T3). The key lives in the KeyProvider, so a DB dump ALONE cannot recover
 * the values. `check-crypto-invariant-5` pins the `createHmac` construction and
 * forbids a bare unkeyed digest (createHash, incl. an aliased import, plus
 * `crypto.hash` / `subtle.digest`) anywhere in crypto src.
 *
 * DOCUMENTED residual leak (I5, T4): equal plaintexts produce equal indexes, so a
 * DB reader sees which rows share a value and how often each value occurs. This is
 * the standard searchable-encryption trade-off, stated openly, never silent. It
 * also PERSISTS across a crypto-shred (T14): destroying the DEK makes the field
 * ciphertext inert but does NOT null this index; that is the host's write path.
 */
export function computeBlindIndex(
  indexKey: Buffer,
  value: string,
  options: BlindIndexOptions = {}
): string {
  return createHmac('sha256', indexKey)
    .update(normalizeForBlindIndex(value, options), 'utf8')
    .digest('hex')
}
