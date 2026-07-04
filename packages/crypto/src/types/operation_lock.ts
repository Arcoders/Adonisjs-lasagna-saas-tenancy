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
export type CryptoOperationLock = <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>
