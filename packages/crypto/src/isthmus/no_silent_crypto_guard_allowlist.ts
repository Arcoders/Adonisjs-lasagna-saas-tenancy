/**
 * Files with a fail-closed refusal `throw` that is deliberately NOT wired to a
 * registered `guard.crypto_*` emit, each with a written reason. The
 * `no_silent_crypto_guard` architectural spec (the satellite mirror of the kernel's
 * scan) allows a refusal site only if its file either is a registered guard file that
 * emits, or appears here.
 *
 * Empty by design: every "refusing …" throw in crypto src lives in a registered guard
 * file (crypto_service.ts, pg_wrapped_dek_store.ts) that emits its own
 * `guard.crypto_*` event before the throw. Keep it empty; add an entry only for a
 * demonstrated, reviewed exception.
 */
export const CRYPTO_NO_SILENT_GUARD_ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = []
