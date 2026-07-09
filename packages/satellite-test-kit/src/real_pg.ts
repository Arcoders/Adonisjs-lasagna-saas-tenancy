// Real-Postgres run policy shared by the satellite integration helpers (crypto,
// AI). Boot-safe: reads only an env var and imports nothing app-dependent, so it
// can live on the eager main barrel (unlike the lucid-backed helpers on /testing).
//
// This mirrors core's `RLS_DB_USER` / `PLUGIN_RO_DB_USER` fail-loud gate. A
// satellite's real-PG helper self-skips when Postgres is unreachable LOCALLY, so a
// dev without infra is not blocked. But a CI job that has declared real Postgres
// mandatory sets `REQUIRE_REAL_PG=1`; when it is set, the helper must turn a
// would-be self-skip into a HARD failure instead — otherwise a PG-less,
// non-CREATEDB, or otherwise hardened runner ships the crown-jewel real-PG proofs
// green by silently skipping them (green ≠ verified).

/** True when a CI job declared a real Postgres run mandatory (`REQUIRE_REAL_PG=1`). */
export function realPgRequired(): boolean {
  const v = process.env.REQUIRE_REAL_PG
  return v === '1' || v === 'true'
}

/**
 * Throw the shared "refusing to pass by skipping" error when {@link realPgRequired}
 * is set; a no-op otherwise (local self-skip is fine). `detail` names the concrete
 * reason the real-PG proof cannot run (PG unreachable, role lacks CREATEDB, ...).
 */
export function failLoudIfRealPgRequired(detail: string): void {
  if (!realPgRequired()) return
  throw new Error(
    `REQUIRE_REAL_PG is set, but a real-Postgres proof cannot run: ${detail}. ` +
      `A required real-PG integration/e2e run must not self-skip ` +
      `(see .github/workflows/ci.yml). Refusing to pass by skipping.`
  )
}
