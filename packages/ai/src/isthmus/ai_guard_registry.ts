import type {
  IsthmusEvidence,
  IsthmusFailMode,
  IsthmusPhase,
  IsthmusSeverity,
} from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The satellite guard registry: the single source of truth for every named
 * fail-closed guard in the AI package, mirroring the kernel's
 * `ISTHMUS_REGISTRY` discipline (see packages/core/src/isthmus/registry.ts).
 *
 * The kernel registry is closed to satellites by design (its id union derives
 * from its own literal array and its CI gate scans core only), so the satellite
 * keeps its own registry and dispatches the kernel's PUBLIC
 * `IsthmusGuardTripped` event class, whose payload `id`/`event` are plain
 * strings precisely so hosts can subscribe once without knowing every guard.
 * The `ai_` class segment in ids and event names makes collision with kernel
 * entries structurally impossible while staying inside the documented
 * `isthmus:<pillar>:<class>:<outcome>` taxonomy.
 *
 * Thinness discipline, inherited from the kernel: an entry exists only for a
 * guard that exists in source and refuses input, with real evidence. Sites
 * that are deliberately NOT entries:
 *
 * - `byok_endpoint_blocked` (base_provider.ts): a wrapper around the kernel's
 *   SSRF pin. The refusal happens (and emits) inside the kernel's safe_fetch
 *   guard; a satellite entry would double-count one rejection.
 * - `AIProviderRegistry.use()/active()` and the `forTenant`
 *   selected-but-not-registered branch: availability and API-misuse errors,
 *   not refusals of untrusted input.
 * - `assertNever`: a compile-time exhaustiveness backstop, unreachable by
 *   construction.
 */

/** ISO calendar date, e.g. '2026-07-02'. */
type IsoDate = `${number}-${number}-${number}`

interface AiGuardRegistryEntryShape {
  /** Stable id, `guard.ai_<name>`. This is what call sites pass to emitAiGuardEvent. */
  readonly id: `guard.ai_${string}`
  /** Every AI guard gates (rejects); the satellite has no seal or audit pillar entries. */
  readonly pillar: 'guard'
  /** Short bug-class tag for dashboards and triage. */
  readonly bugClass: string
  readonly failMode: IsthmusFailMode
  /** 'config' = trips at boot/registration and aborts the deploy; 'runtime' = per request. */
  readonly phase: IsthmusPhase
  readonly event: `isthmus:guard:ai_${string}:rejected`
  readonly severity: IsthmusSeverity
  /** Required, non-empty: why this guard exists. */
  readonly evidence: IsthmusEvidence
  /** Path of the module containing the throw site(s), relative to packages/ai/. */
  readonly guardFile: string
  readonly reviewed: IsoDate
  /** Drives the 6-month review, matching the kernel registry's cadence. */
  readonly nextReview: IsoDate
}

export const AI_GUARD_REGISTRY = [
  {
    id: 'guard.ai_provider_allowlist',
    pillar: 'guard',
    bugClass: 'capability-exposure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_provider:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'G12 default-deny: a provider resolved outside the tenant allow-list is config drift or a capability probe; adding a provider must never auto-expose it',
    },
    guardFile: 'src/services/tenant_provider_selection.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_model_allowlist',
    pillar: 'guard',
    bugClass: 'capability-exposure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_model:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'G12 model scope: a request naming a model outside the per-provider allow-list is the same default-deny class as the provider gate, one level down',
    },
    guardFile: 'src/providers/base_provider.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_access',
    pillar: 'guard',
    bugClass: 'missing-authorization',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_access:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'the gateway sequence authorizes FIRST so a denied caller spends nothing (G4); severity warn because membership denials are normal operations, not presumptive intrusion',
    },
    guardFile: 'src/gateway/access_gate.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_idempotency_key',
    pillar: 'guard',
    bugClass: 'cache-poisoning-surface',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_idempotency:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'the Idempotency-Key header is the only client-supplied input to the replay-cache key derivation (G7); an unbounded or non-printable key must be a 400, never MAC input',
    },
    guardFile: 'src/gateway/idempotency.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_streaming_capability',
    pillar: 'guard',
    bugClass: 'silent-degradation',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:ai_streaming:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'the registration presence gate (the one divergence from billing): a non-streaming provider admitted at boot would buffer whole responses and break mid-stream cost control at runtime',
    },
    guardFile: 'src/services/ai_provider_registry.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_config_invalid',
    pillar: 'guard',
    bugClass: 'config-drift',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:ai_config:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'eager boot validation (the assertConfigBounds pattern): a malformed ai block must abort the deploy, not surface as the first tenant stream failing',
    },
    guardFile: 'src/validate_config.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
] as const satisfies readonly AiGuardRegistryEntryShape[]

/** Compile-time union of all registered AI guard ids. */
export type AiGuardId = (typeof AI_GUARD_REGISTRY)[number]['id']

/** A single registry entry, literal-narrowed. */
export type AiGuardRegistryEntry = (typeof AI_GUARD_REGISTRY)[number]

/** Look up a registry entry by id. Ids are compile-checked, so a miss is a programming error. */
export function aiGuardEntry(id: AiGuardId): AiGuardRegistryEntry {
  const entry = AI_GUARD_REGISTRY.find((candidate) => candidate.id === id)
  if (!entry) {
    throw new Error(`[ai] unknown AI guard id: ${id}`)
  }
  return entry
}
