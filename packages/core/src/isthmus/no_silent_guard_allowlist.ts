/**
 * Allowlist for the no-silent-guard scan: fail-closed `throw` sites (detected by
 * a "refus…" message adjacent to the throw) that are DELIBERATELY not registered
 * in the Isthmus and therefore emit no event. One entry per path, each with a
 * written reason. An unexplained silent guard fails both the
 * `@architecture/boundaries/no_silent_guard` spec and `scripts/check-isthmus.mjs`
 * (which parses this file textually; keep entries literal).
 *
 * This list is the Audit-coverage Index's denominator adjustment: every entry
 * added here lowers the pressure on the Index, so additions need the same
 * evidence discipline as registry entries: say WHY observability adds nothing.
 */
export const NO_SILENT_GUARD_ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'src/sdk/configure_kit.ts',
    why: 'configure-time CLI guard (migrations dir escaping the package root): trips in the host developer shell during `node ace configure`, where the loud error IS the signal — there is no booted app, no listener, and no ops channel to alert',
  },
  {
    path: 'src/services/worm_ledger_writer.ts',
    why: 'shared low-level WORM append primitive: its fail-closed throws (write failure, tenant-scope mismatch) are surfaced by the CALLER, which owns the domain guard — crypto shred maps a write failure to guard.crypto_shred_unaudited and aborts, and every future caller (governance, AI) emits its own guard. The writer has no listener or ops channel of its own; observability lives at the call site, so a guard here would be duplicate noise',
  },
  {
    path: 'src/services/isolation/pooled_pg_driver.ts',
    why: "read-only firewall SETUP failure (ensureReadOnlyClient): the manager is unavailable, the primary was never established, the clone's pool is mid-recycle, or the SELECT-only clone could not be registered. These are operational/transient states, not an attack signal — the write attempt itself is what Postgres denies, and this throw only reports that the firewall could not be built THIS call, denying the request with a loud typed IsolationConfigException that surfaces as the request's own error. Before cloning, the primary is identity-sealed against this tenant via verifyCachedConnection (guard.seal.connection_identity), so a stale/collided primary is caught by THAT guard, which does emit; there is nothing an extra audit event here would add that the denied request or the seal does not already carry",
  },
  {
    path: 'src/models/adapters/tenant_adapter.ts',
    why: "read-only firewall SETUP failure at the routing seam: when untrusted plugin code is on the stack but the active driver offers no per-tenant SELECT-only clone (ensureReadOnlyClient absent, e.g. rowscope-pg/sqlite-memory), the adapter denies the query fail-closed rather than route untrusted code to a writable connection. This reports a missing firewall capability THIS call, not an attack — the loud typed IsolationConfigException surfaces as the request's own error. The driver owns the firewall and its audit: the real read-only enforcement is Postgres denying the write, and the primary is identity-sealed (guard.seal.connection_identity) before any clone; an extra audit event here would duplicate what the denied request and the driver's seal already carry",
  },
]
