import type {
  IsthmusEvidence,
  IsthmusFailMode,
  IsthmusPhase,
  IsthmusSeverity,
} from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The satellite guard registry: the single source of truth for every named
 * fail-closed guard in the crypto package, mirroring the AI satellite's
 * `AI_GUARD_REGISTRY` discipline (packages/ai/src/isthmus/ai_guard_registry.ts) and,
 * through it, the kernel's `ISTHMUS_REGISTRY`.
 *
 * The kernel registry is closed to satellites by design (its id union derives from
 * its own literal array and its CI gate scans core only), so crypto keeps its own
 * registry and dispatches the kernel's PUBLIC `IsthmusGuardTripped` event, whose
 * payload `id`/`event` are plain strings so hosts subscribe once without knowing
 * every guard. The `crypto_` class segment in ids and event names makes collision
 * with kernel or AI entries structurally impossible while staying inside the
 * documented `isthmus:<pillar>:<class>:<outcome>` taxonomy.
 *
 * Thinness discipline, inherited from the kernel: an entry exists only for a guard
 * that exists in source and refuses input, with real evidence and a real emit site.
 * Sites that are deliberately NOT entries:
 *
 * - `guard.crypto_plaintext_write` (design §7): a plaintext write to an `@encrypted`
 *   column is refused at the DATABASE layer by the `enc_v2:`/`enc_v1:` prefix CHECK
 *   (invariant-3, src/schema/encrypted_column.ts), the only enforcement that catches
 *   the raw-SQL / query-builder bypass. crypto never sees that write to emit on it, so
 *   there is no app-level entry (the DB constraint IS the guard).
 * - `dek_missing` / `no_tenant_scope` / `rowscope_unsupported` / `dek_conflict`: real
 *   fail-closed throws, but availability / not-yet-supported / API-shape errors, not
 *   refusals of a security decision with a distinct isthmus event.
 */

/** ISO calendar date, e.g. '2026-07-04'. */
type IsoDate = `${number}-${number}-${number}`

interface CryptoGuardRegistryEntryShape {
  /** Stable id, `guard.crypto_<name>`. This is what call sites pass to emitCryptoGuardEvent. */
  readonly id: `guard.crypto_${string}`
  /** Every crypto guard gates (rejects); the satellite has no seal or audit pillar entries. */
  readonly pillar: 'guard'
  /** Short bug-class tag for dashboards and triage. */
  readonly bugClass: string
  readonly failMode: IsthmusFailMode
  /** 'config' = trips at boot/validation and aborts the deploy; 'runtime' = per request. */
  readonly phase: IsthmusPhase
  readonly event: `isthmus:guard:crypto_${string}:rejected`
  readonly severity: IsthmusSeverity
  /** Required, non-empty: why this guard exists. */
  readonly evidence: IsthmusEvidence
  /** Path of the module containing the throw/emit site(s), relative to packages/crypto/. */
  readonly guardFile: string
  readonly reviewed: IsoDate
  /** Drives the 6-month review, matching the kernel registry's cadence. */
  readonly nextReview: IsoDate
}

export const CRYPTO_GUARD_REGISTRY = [
  {
    id: 'guard.crypto_dek_unwrap_failed',
    pillar: 'guard',
    bugClass: 'key-unwrap-failure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:crypto_dek_unwrap:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'I3/T6 fail-closed read: a DEK that cannot be unwrapped (KMS down, wrong KEK, GCM tamper) makes the read fail; it must never fall back to a shared or plaintext key, so the failure is surfaced, not swallowed',
    },
    guardFile: 'src/services/crypto_service.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
  {
    id: 'guard.crypto_shred_legal_hold',
    pillar: 'guard',
    bugClass: 'compliance-erasure-refusal',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:crypto_shred_legal_hold:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'I7/T9: destroying a legal-obligation DEK within retention is an irreversible violation in the other direction; an absent or non-erasable governance verdict refuses the shred, never defaults to erase',
    },
    guardFile: 'src/services/crypto_service.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
  {
    id: 'guard.crypto_shred_unaudited',
    pillar: 'guard',
    bugClass: 'audit-integrity',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:crypto_shred_unaudited:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: '§6.6 two-phase audit: an irreversible erasure is never run unaudited; if no WORM ledger is wired or the PENDING append fails before the delete, the shred aborts with nothing destroyed',
    },
    guardFile: 'src/services/crypto_service.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
  {
    id: 'guard.crypto_keyprovider_unavailable',
    pillar: 'guard',
    bugClass: 'key-backend-unavailable',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:crypto_keyprovider:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'the env KeyProvider derives the KEK from APP_KEY; with APP_KEY unset (or a real KMS/Vault backend unreachable) a wrap/unwrap cannot proceed and fails closed rather than writing an unencrypted value or a weak key',
    },
    guardFile: 'src/services/env_key_provider.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
  {
    id: 'guard.crypto_config_invalid',
    pillar: 'guard',
    bugClass: 'config-drift',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:crypto_config:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'eager boot validation (the assertConfigBounds pattern): a malformed config.crypto block must abort the deploy, not surface as the first tenant encrypted write failing',
    },
    guardFile: 'src/validate_config.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
  {
    id: 'guard.crypto_scope_mismatch',
    pillar: 'guard',
    bugClass: 'cross-tenant-leak',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:crypto_scope_mismatch:rejected',
    severity: 'critical',
    evidence: {
      kind: 'invariant',
      ref: 'I4: the wrapped-DEK store runs raw SQL, which bypasses the kernel ContextSeal (it fires only inside the model adapter); the store re-asserts the request tenant equals the active tenancy scope before any query, so a mis-wired call cannot read another tenant DEK',
    },
    guardFile: 'src/services/pg_wrapped_dek_store.ts',
    reviewed: '2026-07-04',
    nextReview: '2027-01-04',
  },
] as const satisfies readonly CryptoGuardRegistryEntryShape[]

/** Compile-time union of all registered crypto guard ids. */
export type CryptoGuardId = (typeof CRYPTO_GUARD_REGISTRY)[number]['id']

/** A single registry entry, literal-narrowed. */
export type CryptoGuardRegistryEntry = (typeof CRYPTO_GUARD_REGISTRY)[number]

/** Look up a registry entry by id. Ids are compile-checked, so a miss is a programming error. */
export function cryptoGuardEntry(id: CryptoGuardId): CryptoGuardRegistryEntry {
  const entry = CRYPTO_GUARD_REGISTRY.find((candidate) => candidate.id === id)
  if (!entry) {
    throw new Error(`[crypto] unknown crypto guard id: ${id}`)
  }
  return entry
}
