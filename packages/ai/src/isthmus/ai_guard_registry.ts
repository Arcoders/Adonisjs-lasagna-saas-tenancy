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
    guardFile: 'src/providers/model_allowlist.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_route_mount',
    pillar: 'guard',
    bugClass: 'unguarded-mount',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:ai_route_mount:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'G4: an AI mount without a middleware chain or membership gate exposes tenant-scoped, cost-bearing routes; the kernel gate only warns, which is too weak for AI, so the mount is default-deny',
    },
    guardFile: 'src/routes/mount_gate.ts',
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
  {
    id: 'guard.ai_rate_limited',
    pillar: 'guard',
    bugClass: 'denial-of-wallet',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_rate_limit:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'the per-key request rate limit (threat #4, BYOK exploitation / denial of wallet): a tenant flooding a shared or BYOK provider key is throttled before the reserve; severity warn because rate limits trip in normal operation and are monitored by rate, not per event',
    },
    guardFile: 'src/services/ai_rate_limiter.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_rowscope_refused',
    pillar: 'guard',
    bugClass: 'weak-isolation-placement',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_rowscope:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'I1: an embedding can be inverted to its source text, so logical (rowscope) isolation is the weakest placement; the vector store refuses it rather than ship a shared-table RLS path, which the ARCHITECTURE marks spike-gated, not a default',
    },
    guardFile: 'src/services/vector_store_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_scope_mismatch',
    pillar: 'guard',
    bugClass: 'cross-tenant-leak',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_scope_mismatch:rejected',
    severity: 'critical',
    evidence: {
      kind: 'invariant',
      ref: 'I1: the vector store runs raw SQL, which bypasses the kernel ContextSeal (it fires only inside the model adapter); the store re-asserts the request tenant equals the active tenancy scope before any query, so a mis-wired call cannot read another tenant embeddings',
    },
    guardFile: 'src/services/vector_store_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_dimension_mismatch',
    pillar: 'guard',
    bugClass: 'index-corruption',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_dimension:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'the embedding vector length must equal the migrated vector(N) dimension; a mismatched or non-finite vector is rejected before the INSERT so a model swap corrupts nothing (it would otherwise mis-rank retrieval silently)',
    },
    guardFile: 'src/services/vector_store_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_embedding_quota_exhausted',
    pillar: 'guard',
    bugClass: 'resource-exhaustion',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_embedding_quota:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'threat #18: a tenant indexing unbounded embeddings exhausts shared storage; the per-plan embeddingCount cap is enforced atomically (advisory-locked count + insert) and trips before the write; severity warn because hitting a plan cap is normal',
    },
    guardFile: 'src/services/vector_store_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_ingestion_denied',
    pillar: 'guard',
    bugClass: 'missing-authorization',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_ingestion:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'the ingestion write gate (distinct from the access gate): writing to the vector index is authorized before any reservation or embed, so a low-privilege caller cannot poison a tenant index; severity warn because ingestion denials are normal operations',
    },
    guardFile: 'src/gateway/access_gate.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_retrieval_denied',
    pillar: 'guard',
    bugClass: 'missing-authorization',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_retrieval:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'G2: tenant isolation is not user authorization; the retrievalFilter document ACL is resolved before any query embed or search, so a hook that throws or returns an invalid scope fails closed (nothing retrieved) rather than falling back to the whole tenant corpus; severity warn because retrieval denials are normal operations',
    },
    guardFile: 'src/gateway/access_gate.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.ai_audit_write_failed',
    pillar: 'guard',
    bugClass: 'audit-integrity',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_audit_write_failed:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'I5 fail-closed matrix: an attributable action whose append-only audit row cannot be written is a failure, not a silent success; the writer emits before it rethrows so an audit outage is observable, and a post-stream chat failure leaves a detectable seq gap',
    },
    guardFile: 'src/services/ai_audit_writer.ts',
    reviewed: '2026-07-03',
    nextReview: '2027-01-03',
  },
  {
    id: 'guard.ai_memory_session_invalid',
    pillar: 'guard',
    bugClass: 'memory-hijack',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_memory_session:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'I2 / G6: conversation-memory sessions are server-minted and HMAC-bound to the (tenant, principal) pair; a supplied sessionId whose MAC does not verify against the CURRENT principal is a hijack or pre-seed attempt on another principal memory, refused with a 400 before any load or persist',
    },
    guardFile: 'src/services/conversation_memory_service.ts',
    reviewed: '2026-07-03',
    nextReview: '2027-01-03',
  },
  {
    id: 'guard.ai_residency_denied',
    pillar: 'guard',
    bugClass: 'data-residency-egress',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_residency:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: '#7/#15: a tenant residency posture pins where its prompts/documents may egress; a provider or embedding backend outside the tenant allow-list (or any remote host under local-only) is refused before the reserve, at BOTH chat provider selection and the embedding egress (embed/retrieve) that has no other choke point',
    },
    guardFile: 'src/services/residency_gate.ts',
    reviewed: '2026-07-03',
    nextReview: '2027-01-03',
  },
  {
    id: 'guard.ai_auto_purge_failed',
    pillar: 'guard',
    bugClass: 'compliance-erasure-failure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_auto_purge:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'WS-AI-9 E6: the tenant-lifecycle auto-purge (on TenantDeleted / TenantAnonymized) must not throw into the already-committed core command, but a swallowed failure would be a silent GDPR erasure that did nothing; the listener emits this guard + a metric so a failed auto-erasure is observable and alertable',
    },
    guardFile: 'src/services/ai_compliance_service.ts',
    reviewed: '2026-07-03',
    nextReview: '2027-01-03',
  },
  {
    id: 'guard.ai_tool_unknown',
    pillar: 'guard',
    bugClass: 'capability-exposure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_unknown:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'WS-AI-11 default-deny: a model naming a tool outside the tenant registry is refused before any execution; registering a tool never auto-exposes it, the provider allow-list one level down',
    },
    guardFile: 'src/gateway/tool_gate.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_tool_denied',
    pillar: 'guard',
    bugClass: 'missing-authorization',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_denied:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'WS-AI-11 I7: the per-tool authorizeTool hook resolves before execution; an absent hook, a throw, or a deny/invalid scope fails closed (never a 500) so a tool cannot run unauthorized; severity warn because tool denials are normal operations',
    },
    guardFile: 'src/gateway/tool_gate.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_tool_input_invalid',
    pillar: 'guard',
    bugClass: 'untrusted-input-schema',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_input_invalid:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'WS-AI-11 #12: tool arguments are model-generated untrusted input; they are bounded, JSON-parsed, prototype-safe reconstructed and schema-checked before execution, so an oversized payload, a __proto__ pollution attempt or a schema mismatch is rejected before the handler runs',
    },
    guardFile: 'src/gateway/tool_input.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_tool_scope_mismatch',
    pillar: 'guard',
    bugClass: 'cross-tenant-leak',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_scope_mismatch:rejected',
    severity: 'critical',
    evidence: {
      kind: 'invariant',
      ref: 'WS-AI-11 I7 / #12 confused deputy: before the executor binds tenancy.run(tenant), assertActiveToolScope re-asserts that any ambient tenancy scope already active equals the request tenant (read BEFORE the bind, mirroring the vector-store #target / audit-writer append re-assert), so a confused-deputy call running inside another tenant scope cannot reach this tenant handler; the kernel ContextSeal backstops each query',
    },
    guardFile: 'src/gateway/tool_gate.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_tool_budget_exhausted',
    pillar: 'guard',
    bugClass: 'denial-of-wallet',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_budget_exhausted:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'WS-AI-11 #12/#13: the tool loop caps rounds and total tool calls under one aggregate token reservation; hitting a ceiling stops the loop in-band rather than letting the model drive an unbounded, wallet-draining call chain; severity warn because a loop ceiling is a bounded, monitored condition',
    },
    guardFile: 'src/gateway/tool_loop.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_tool_action_disabled',
    pillar: 'guard',
    bugClass: 'unguarded-mutation',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_tool_action_disabled:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'WS-AI-11 LLM06: a mode:action (mutating) tool is off by default and refused at execution unless explicitly enabled and human-confirmed (Phase 3a), so an indirect prompt injection can propose a write but never perform one',
    },
    guardFile: 'src/gateway/tool_gate.ts',
    reviewed: '2026-07-16',
    nextReview: '2027-01-16',
  },
  {
    id: 'guard.ai_too_many_concurrent',
    pillar: 'guard',
    bugClass: 'denial-of-wallet',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:ai_too_many_concurrent:rejected',
    severity: 'warn',
    evidence: {
      kind: 'inherent-risk',
      ref: 'WS-AI-11 Phase 2a: the per-tenant admission cap on concurrent in-flight streams, the anti-flood half of the denial-of-wallet rail. A tenant already at its cap is refused a NEW tool loop before the reserve rather than starting one. Severity warn for the same reason as its sibling ai_rate_limited: an admission cap trips in normal operation under load and is monitored by rate, not per event. Honest limit (the acquire docstring says the same): this bounds TOTAL in-flight streams, not tool loops exactly, and is per-process',
    },
    guardFile: 'src/services/tenant_liveness_watcher.ts',
    reviewed: '2026-07-17',
    nextReview: '2027-01-17',
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
