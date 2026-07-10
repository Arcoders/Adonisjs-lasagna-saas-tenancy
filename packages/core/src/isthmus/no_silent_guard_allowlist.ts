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
]
