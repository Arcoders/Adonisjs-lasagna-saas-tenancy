/**
 * The per-tenant operation-lock seam (I10, §6.6). Provision and shred serialize on
 * it so two concurrent writes to one `(subject × category)` DEK cannot interleave
 * (T12). It is INJECTED into {@link ../services/crypto_service.js CryptoService} (not
 * imported) so the service stays unit-testable and its `src` never value-imports a
 * Redis client; the provider wires the real cross-process lock
 * ({@link ../internal/operation_lock.js withCryptoOperationLock}).
 *
 * ABSENT ⇒ the critical sections run WITHOUT cross-process serialization. That is a
 * SAFE degraded mode, not a silent hole: the partial `UNIQUE (subject_id, category)
 * WHERE shredded_at IS NULL` is the real singularity guarantee (a racing second
 * provision is refused fail-closed at the DB, I10), and the lock is defense-in-depth
 * that turns a hard conflict into clean serialization. Unit tests inject a fake to
 * assert the critical sections are wrapped.
 */

/**
 * How the lock behaves when another holder already owns it (contention), chosen per
 * call site by what an unserialised overlap costs:
 *
 * - `'fail-open'` (default): the caller proceeds WITHOUT the lock. Right for the
 *   provision/encrypt hot path, where the partial `UNIQUE` genuinely serialises the
 *   only mutation (the racing INSERT) and blocking every write on the coordination
 *   layer is worse than a rare unserialised read.
 * - `'serialize'`: the caller waits (bounded, jittered backoff) for the holder to
 *   release, then proceeds; if it cannot acquire within the window it is REFUSED
 *   (`shred_in_progress`, retriable). Right for the shred path, whose two-phase WORM
 *   audit must not run concurrently with itself (a fail-open overlap would append a
 *   duplicate ledger entry). Redis-down still degrades to fail-open for both modes;
 *   the shred path's authoritative `shredLive()` return is the backstop there.
 */
export type LockContention = 'fail-open' | 'serialize'

/** Per-call lock options. Absent ⇒ `{ onContention: 'fail-open' }`. */
export interface CryptoLockOptions {
  readonly onContention?: LockContention
}

export type CryptoOperationLock = <T>(
  tenantId: string,
  fn: () => Promise<T>,
  options?: CryptoLockOptions
) => Promise<T>
