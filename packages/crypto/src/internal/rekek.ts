/**
 * The pure cursor classification for KEK rotation (`tenant:crypto:rekek`, I8,
 * §6.7). Kept pure and separate so the branch whose bug would needlessly re-wrap
 * (or silently skip) a DEK is unit-testable without a KeyProvider or a database. It
 * mirrors `secrets_rotation.ts`'s current/rotate PATTERN, but on the KEK axis: it
 * classifies a WRAPPED-DEK ROW by its `kek_id` cursor, not an enc_v2 value string,
 * and it never decrypts a field value (I8; the `rewrap` outcome is executed by
 * re-WRAPPING the DEK via the KeyProvider, never `openV2WithKey`-then-`sealV2WithKey`).
 */

/** The cursor decision for one wrapped-DEK row. `failed` is an I/O outcome, not a pure one. */
export type RekekAction =
  | 'current' // the row is already at the current KEK generation: idempotent skip
  | 'rewrap' // the row is at an older (or unknown) generation: unwrap-then-re-wrap

/**
 * Classify a wrapped-DEK row for re-wrapping by comparing its stored `kek_id`
 * against the KeyProvider's current generation cursor.
 *
 * When `currentKekId` is known (the provider implements the optional cursor), a
 * matching row is skipped WITHOUT unwrapping — the cheap, idempotent, resumable
 * skip a re-run relies on. When it is undefined (a provider that cannot report its
 * current generation), every row is a `rewrap` candidate and the walker resolves
 * `current` vs `rotate` post-hoc, by re-wrapping and comparing the fresh `kek_id`
 * to the row's.
 */
export function classifyRekek(rowKekId: string, currentKekId: string | undefined): RekekAction {
  if (currentKekId !== undefined && rowKekId === currentKekId) return 'current'
  return 'rewrap'
}
