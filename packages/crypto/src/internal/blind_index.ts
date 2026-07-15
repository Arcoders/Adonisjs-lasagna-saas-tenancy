import { createHmac } from 'node:crypto'

/**
 * Options for the deterministic blind index. The core normalization (NFKC then
 * trim) is fixed so two encodings of one value collide. Case-folding is opt-in
 * because it is field-dependent: a passport number folds case, a case-sensitive
 * token does not.
 */
export interface BlindIndexOptions {
  /**
   * Case-fold the value before hashing so `'ab12'` and `'AB12'` index equally.
   * Opt-in per field (default false): the host declares it deliberately, folding
   * case only where the field semantics allow. Uses a locale-independent
   * `toUpperCase()` so the fold is deterministic across environments.
   */
  caseInsensitive?: boolean | undefined
}

/**
 * The pinned blind-index normalization. NFKC folds compatibility encodings (so two
 * Unicode spellings of one identifier collide), `trim` removes surrounding
 * whitespace, and the opt-in uppercase fold makes the index case-insensitive. This
 * function is frozen: changing it re-derives every host index column and breaks
 * equality against the indexes already stored (it would be an `enc_v3`-grade break).
 */
export function normalizeForBlindIndex(value: string, options: BlindIndexOptions = {}): string {
  const normalized = value.normalize('NFKC').trim()
  return options.caseInsensitive ? normalized.toUpperCase() : normalized
}

/**
 * Compute the deterministic blind index: a keyed HMAC-SHA256 over the normalized
 * value. It is a keyed HMAC via {@link createHmac}, never a bare `createHash` of a
 * salt and the value. A low-entropy identifier like a passport number is only a few
 * million candidates, so an unkeyed hash is trivially brute-forced from a DB dump.
 * The key lives in the KeyProvider, so a DB dump alone cannot recover the values.
 * `check-crypto-invariant-5` pins the `createHmac` construction and forbids a bare
 * unkeyed digest (createHash, including an aliased import, plus `crypto.hash` /
 * `subtle.digest`) anywhere in crypto src.
 *
 * One residual leak is documented and accepted: equal plaintexts produce equal
 * indexes, so a DB reader sees which rows share a value and how often each value
 * occurs. This is the standard searchable-encryption trade-off, stated openly and
 * never silent. It also persists across a crypto-shred: destroying the DEK makes the
 * field ciphertext inert but does not null this index, and that is the host's write
 * path.
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
