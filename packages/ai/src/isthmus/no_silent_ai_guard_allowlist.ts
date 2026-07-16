/**
 * Files allowed to carry a fail-closed "Refusing …" throw WITHOUT a registered
 * AI guard that emits. Single-sourced so the `@architecture` scan
 * (no_silent_ai_guard.spec.ts) reads one list, mirroring the kernel's
 * `NO_SILENT_GUARD_ALLOWLIST` discipline: every entry needs a written reason,
 * and a stale entry (path gone, or no refusal site left) fails the spec.
 *
 * Empty on purpose: every refusal in the AI package today belongs to a
 * registered guard. Add an entry only with a reason a reviewer can act on.
 */
export const AI_NO_SILENT_GUARD_ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = []
