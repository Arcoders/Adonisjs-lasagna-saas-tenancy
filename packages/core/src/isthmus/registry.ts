import type {
  IsthmusEvidence,
  IsthmusFailMode,
  IsthmusPhase,
  IsthmusPillar,
  IsthmusSeverity,
} from '../types/isthmus.js'

/**
 * The Isthmus registry: the single source of truth for every named fail-closed
 * guard in the package, in the declarative style of `SECRET_CONFIG_FIELDS`.
 *
 * Thinness discipline: an entry exists only for a guard that exists in source
 * and carries real evidence (a CVE, an incident, an inherent risk, or an
 * invariant). No speculative entries. The `@architecture` contract spec
 * (isthmus_contract.spec.ts) pins the shape: every non-audit entry's
 * `guardFile` must contain an `emitIsthmusEvent(` call, every emit call in
 * `src` must reference a registered id, and every entry must carry evidence
 * and review dates. `scripts/check-isthmus.mjs` reads this file textually for
 * the CI audit-coverage gate, so entries must stay literal (no computed
 * values).
 *
 * `resolution_safety.ts` is deliberately NOT a separate entry: it is a pure
 * detector (it returns findings, dispatches nothing), single-sourced and
 * pinned by its own spec. Its enforcement point, the production hard-fail in
 * `assertConfigBounds`, is what rejects, so that is what the registry names
 * (`guard.resolution_safety`).
 */

/** ISO calendar date, e.g. '2026-07-02'. */
type IsoDate = `${number}-${number}-${number}`

/**
 * Event taxonomy: `isthmus:<pillar>:<class>:<outcome>` for every new event.
 * The one grandfathered name is `scope:bypass`: it shipped before the
 * taxonomy (see SCOPE_BYPASS_ACTION in models/scope_bypass_audit.ts) and
 * renaming a public event would break subscribed hosts.
 */
type IsthmusEventName = `isthmus:${IsthmusPillar}:${string}:${string}` | 'scope:bypass'

interface IsthmusRegistryEntryShape {
  /** Stable id, `<pillar>.<name>`. This is what call sites pass to emitIsthmusEvent. */
  readonly id: `${IsthmusPillar}.${string}`
  readonly pillar: IsthmusPillar
  /** Short bug-class tag for dashboards and triage. */
  readonly bugClass: string
  readonly failMode: IsthmusFailMode
  /** 'config' = trips at register()/boot()/start() and aborts the deploy; 'runtime' = post-ready. */
  readonly phase: IsthmusPhase
  readonly event: IsthmusEventName
  readonly severity: IsthmusSeverity
  /** Required, non-empty: why this guard exists. */
  readonly evidence: IsthmusEvidence
  /** Path of the module containing the throw site(s), relative to packages/core/. */
  readonly guardFile: string
  readonly reviewed: IsoDate
  /** Drives the 6-month review; check-isthmus.mjs lists entries past this date. */
  readonly nextReview: IsoDate
}

export const ISTHMUS_REGISTRY = [
  {
    id: 'guard.tenant_identifier',
    pillar: 'guard',
    bugClass: 'sql-identifier-injection',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:identifier:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'tenant ids are interpolated into quoted PG DDL (CREATE SCHEMA/DROP DATABASE) and Redis key segments; a homoglyph or quote reaches raw SQL',
    },
    guardFile: 'src/isthmus/guarded_identifier.ts',
    reviewed: '2026-07-13',
    nextReview: '2027-01-13',
  },
  {
    id: 'guard.plugin_authorizer',
    pillar: 'guard',
    bugClass: 'authorizer-fail-open',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:plugin_authorizer:denied',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a plugin authorizer that THROWS must be treated as a DENY (fail-closed); a swallowed throw would open tenant access to a caller the chain meant to reject',
    },
    guardFile: 'src/services/authorizer_registry.ts',
    reviewed: '2026-07-07',
    nextReview: '2027-01-07',
  },
  {
    id: 'guard.plugin_core_access',
    pillar: 'guard',
    bugClass: 'untrusted-plugin-core-access',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:plugin_core_access:denied',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'untrusted plugin code that resolves the host tenant repository or the shared db handle could enumerate or mutate other tenants; the sanctioned funnel denies it (in-process friction; the Postgres read-only role is the hard boundary)',
    },
    guardFile: 'src/services/plugin_core_access.ts',
    reviewed: '2026-07-08',
    nextReview: '2027-01-08',
  },
  {
    id: 'guard.plugin_capability_trust',
    pillar: 'guard',
    bugClass: 'untrusted-capability-access',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:plugin_capability_trust:denied',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a sensitive capability (raw tenant data or key material) provided or consumed by a plugin outside the trusted allowlist crosses the composition boundary; the registry refuses it unless the plugin is trusted',
    },
    guardFile: 'src/services/capability_registry.ts',
    reviewed: '2026-07-08',
    nextReview: '2027-01-08',
  },
  {
    id: 'guard.plugin_extension_identifier',
    pillar: 'guard',
    bugClass: 'plugin-identifier-injection',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:plugin_extension_identifier:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a plugin name, authorizer, capability key, or model name is minted from author input and interpolated into a Redis key, a Symbol, or DDL; a homoglyph or a colon must be rejected at the plugin surface, not folded onto an existing id',
    },
    guardFile: 'src/sdk/brands.ts',
    reviewed: '2026-07-08',
    nextReview: '2027-01-08',
  },
  {
    id: 'guard.redirect_host',
    pillar: 'guard',
    bugClass: 'open-redirect',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:redirect_host:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'tenant.customDomain is interpolated into a Location header; "evil.com#@trusted.com" crafts an open redirect',
    },
    guardFile: 'src/services/cross_domain_redirect_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.redirect_host_label',
    pillar: 'guard',
    bugClass: 'open-redirect',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:redirect_label:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'the tenant slug becomes a subdomain label in a redirect URL; an unsafe label re-targets the host',
    },
    guardFile: 'src/services/cross_domain_redirect_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.redirect_port',
    pillar: 'guard',
    bugClass: 'open-redirect',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:redirect_port:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'a URL port must be an integer in 1..65535; anything else corrupts the assembled URL',
    },
    guardFile: 'src/services/cross_domain_redirect_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.redirect_path',
    pillar: 'guard',
    bugClass: 'header-injection',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:redirect_path:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'CR/LF in a redirect path smuggles headers; a protocol-relative "//" path bypasses the validated host',
    },
    guardFile: 'src/services/cross_domain_redirect_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.config_bounds',
    pillar: 'guard',
    bugClass: 'config-out-of-bounds',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:config_bounds:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'a zero pool size, negative grace window, or weak standing secret must abort the deploy, not surface later as eviction churn or a dead pool',
    },
    guardFile: 'src/providers/assert_config_bounds.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.resolution_safety',
    pillar: 'guard',
    bugClass: 'cross-tenant-resolution-posture',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:resolution_safety:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a client-controlled strategy with no membership gate is an IDOR; a host strategy with no expectedHostSuffix is a spoofable tenant-hop (resolutionSafetyAudit)',
    },
    guardFile: 'src/providers/assert_config_bounds.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.resolver_chain',
    pillar: 'guard',
    bugClass: 'resolver-misconfig',
    failMode: 'closed',
    phase: 'config',
    event: 'isthmus:guard:resolver_chain:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'a resolverChain entry naming no known resolver would pick the wrong (or no) tenant; fail at boot with the offender named',
    },
    guardFile: 'src/providers/resolver_chain.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.metric_value',
    pillar: 'guard',
    bugClass: 'metric-injection',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:metric_value:rejected',
    severity: 'warn',
    evidence: {
      kind: 'invariant',
      ref: 'the Redis counter pipeline uses INCRBY (integers only); a non-integer metric value is a programming error surfaced loudly',
    },
    guardFile: 'src/services/metrics_validation.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.metrics_endpoint',
    pillar: 'guard',
    bugClass: 'tenant-enumeration-exposure',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:metrics_endpoint:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a public /metrics leaks tenant enumeration and business KPIs; mounting it without a guard must be an explicit opt-out, never a default',
    },
    guardFile: 'src/health/assert_metrics_guarded.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.rls_guc_name',
    pillar: 'guard',
    bugClass: 'rls-misconfig',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:rls_guc:rejected',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'a malformed RLS setting name makes the policy read an unset GUC and silently return zero rows; surface the config bug loudly',
    },
    guardFile: 'src/services/isolation/rls.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.broadcast_channel',
    pillar: 'guard',
    bugClass: 'channel-namespace-escape',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:broadcast_channel:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'Transmit treats "/" as hierarchy; an unfiltered ".." channel segment broadcasts into a sibling tenant namespace',
    },
    guardFile: 'src/services/bootstrappers/transmit_bootstrapper.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.outbound_fetch',
    pillar: 'guard',
    bugClass: 'ssrf',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:outbound_fetch:rejected',
    severity: 'high',
    evidence: {
      kind: 'incident',
      ref: 'the PR-0 safeFetch spike: attacker-influenced destinations (webhooks, OIDC discovery) must resolve to a pinned public address — private/link-local targets are SSRF',
    },
    guardFile: 'src/utils/safe_fetch.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'guard.webhook_url',
    pillar: 'guard',
    bugClass: 'ssrf',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:guard:webhook_url:rejected',
    severity: 'high',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a persisted webhook URL is fetched later from inside the network; validating at the service boundary stops callers that bypass the admin controller from storing an SSRF-capable URL',
    },
    guardFile: 'src/services/webhook_service.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'seal.connection_identity',
    pillar: 'seal',
    bugClass: 'cross-tenant-connection',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:seal:connection:mismatch',
    severity: 'critical',
    evidence: {
      kind: 'inherent-risk',
      ref: 'a name collision or stale registration would serve a cached connection pinned to another tenant (schema-pg checks searchPath, database-pg checks the database) — a silent cross-tenant leak',
    },
    guardFile: 'src/services/isolation/connection_identity_seal.ts',
    reviewed: '2026-07-12',
    nextReview: '2027-01-12',
  },
  {
    id: 'seal.scope_required',
    pillar: 'seal',
    bugClass: 'unscoped-query',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:seal:scope:missing',
    severity: 'high',
    evidence: {
      kind: 'invariant',
      ref: 'a scoped model queried outside tenancy.run() and unscoped() must not fall through to a global (cross-tenant) query',
    },
    guardFile: 'src/models/scoping.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'seal.scope_owner_mismatch',
    pillar: 'seal',
    bugClass: 'cross-tenant-write',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:seal:scope:mismatch',
    severity: 'critical',
    evidence: {
      kind: 'invariant',
      ref: 'creating/updating/deleting a row owned by another tenant from the active context is a cross-tenant write; require unscoped() for a deliberate one',
    },
    guardFile: 'src/models/scoping.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'seal.tenant_context',
    pillar: 'seal',
    bugClass: 'context-confusion',
    failMode: 'closed',
    phase: 'runtime',
    event: 'isthmus:seal:tenant:mismatch',
    severity: 'critical',
    evidence: {
      kind: 'invariant',
      ref: 'I1: never route tenant A queries under tenant B context — when the tenancy scope and the request resolve different tenants, refuse to route',
    },
    guardFile: 'src/models/adapters/tenant_adapter.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
  {
    id: 'audit.scope_bypass',
    pillar: 'audit',
    bugClass: 'cross-tenant-escape-hatch',
    failMode: 'open',
    phase: 'runtime',
    event: 'scope:bypass',
    severity: 'info',
    evidence: {
      kind: 'invariant',
      ref: 'every outermost unscoped() emits one attributed, rate-limited audit event so a cross-tenant escape is never invisible',
    },
    guardFile: 'src/models/scope_bypass_audit.ts',
    reviewed: '2026-07-02',
    nextReview: '2027-01-02',
  },
] as const satisfies readonly IsthmusRegistryEntryShape[]

/** Compile-time id union: emitIsthmusEvent(id) cannot reference an unregistered guard. */
export type IsthmusGuardId = (typeof ISTHMUS_REGISTRY)[number]['id']
export type IsthmusRegistryEntry = (typeof ISTHMUS_REGISTRY)[number]

const BY_ID = new Map<IsthmusGuardId, IsthmusRegistryEntry>(
  ISTHMUS_REGISTRY.map((entry) => [entry.id, entry])
)

/** Look up a registry entry by id. Total: the id union guarantees a hit. */
export function isthmusEntry(id: IsthmusGuardId): IsthmusRegistryEntry {
  return BY_ID.get(id)!
}
