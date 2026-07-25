/**
 * "The doctor never harms the patient", made into data.
 *
 * Every issue the doctor can auto-fix is registered here with the do-no-harm effect
 * class its envelope guarantees, and every issue it deliberately leaves for a human is
 * in {@link SURFACE_ONLY} with a one-line reason. Three machine checks stand on this:
 *
 *  - C1 (descriptor completeness): every code emitted with `fixable: true` has a
 *    {@link SafeFix} descriptor here (and is NOT in {@link SURFACE_ONLY}), so a new fix
 *    cannot ship without declaring its effect class. Enforced per-code by the
 *    `fix_coverage_completeness` spec.
 *  - C2 (coverage completeness): every code a check emits is either fixable-with-a
 *    -descriptor or explicitly surface-only, so "cover ALL the warnings, not just the
 *    ones I reported" is enforced forever: a new code that is neither fails CI.
 *  - Do-no-harm behavior: each effect class's non-destructiveness is exercised
 *    end-to-end on real Postgres — physical-identity by the ledger-reconcile resilience
 *    spec (data fingerprint byte-preserved across the rewrite) and additive-only by the
 *    tenant-heal resilience + fault-injection specs (heal never drops/resets/downs, and
 *    a duplicate-object collision is surfaced, never a destructive retry).
 *
 * The effect classes form a lattice of increasing invasiveness, and each maps to the
 * envelope that enforces it (see {@link FixEffectClass}).
 */

/**
 * The do-no-harm class a fix's envelope guarantees, ordered by how much it may touch:
 *  - `operational-only`  — resets in-memory/Redis runtime state (a circuit breaker).
 *    Touches NO tenant data, schema, or lifecycle status.
 *  - `status-only`       — a single lifecycle-status column write on the tenant row.
 *    No DDL, no tenant-schema data. Enforced by {@link applyFix}'s status-only mutate.
 *  - `additive-only`     — forward migrations only (provision-if-missing, migrate-up).
 *    NEVER drop/reset/down/rollback. Enforced by the healer doctrine + the benign
 *    duplicate-object net (a collision is surfaced, never a destructive retry).
 *  - `physical-identity` — rewrites metadata (one `adonis_schema.name`) with ZERO DDL
 *    and asserts the affected tables' data fingerprint is byte-identical before and
 *    after, INSIDE the transaction. Enforced by {@link reconcileTenantLedger} gate 12.
 */
export type FixEffectClass =
  | 'operational-only'
  | 'status-only'
  | 'additive-only'
  | 'physical-identity'

/** Which envelope applies a fix — the property harness targets each by name. */
export type FixEnvelope = 'circuit' | 'status' | 'heal' | 'reconcile'

/** The independent health axes a fix can move toward ⊤ (see the health lattice). */
export type HealthAxis =
  | 'lifecycle'
  | 'storage'
  | 'ledger-fidelity'
  | 'runtime-circuit'
  | 'recoverability'

/** A registered auto-fix and the do-no-harm contract it must honour. */
export interface SafeFix {
  /** The `DiagnosisIssue.code` this fix repairs. */
  code: string
  /** The health axis the fix moves toward health. */
  healthAxis: HealthAxis
  /** The do-no-harm class the envelope guarantees. */
  effectClass: FixEffectClass
  /** The envelope that applies (and enforces) the fix. */
  envelope: FixEnvelope
}

/**
 * The full fix registry. A fixable check's issue code MUST appear here (asserted by the
 * descriptor-completeness test), and every entry's effect class is proven non-destructive
 * by the do-no-harm property harness.
 */
export const SAFE_FIXES: readonly SafeFix[] = [
  // Heal (additive-only): provision-if-missing + migrate-up + seed; never destructive.
  {
    code: 'tenant_failed',
    healthAxis: 'recoverability',
    effectClass: 'additive-only',
    envelope: 'heal',
  },
  { code: 'schema_missing', healthAxis: 'storage', effectClass: 'additive-only', envelope: 'heal' },
  {
    code: 'migrations_never_ran',
    healthAxis: 'storage',
    effectClass: 'additive-only',
    envelope: 'heal',
  },
  {
    code: 'migration_behind',
    healthAxis: 'ledger-fidelity',
    effectClass: 'additive-only',
    envelope: 'heal',
  },
  // Reconcile (physical-identity): rewrite one ledger row, zero DDL, data byte-identical.
  {
    code: 'migration_relocated',
    healthAxis: 'ledger-fidelity',
    effectClass: 'physical-identity',
    envelope: 'reconcile',
  },
  // Status-only: a single lifecycle-status column write, no DDL, no data.
  {
    code: 'provisioning_stalled',
    healthAxis: 'lifecycle',
    effectClass: 'status-only',
    envelope: 'status',
  },
  {
    code: 'lifecycle_status_divergence',
    healthAxis: 'lifecycle',
    effectClass: 'status-only',
    envelope: 'status',
  },
  // Operational-only: reset the runtime circuit; touches no tenant data or status.
  {
    code: 'circuit_open',
    healthAxis: 'runtime-circuit',
    effectClass: 'operational-only',
    envelope: 'circuit',
  },
]

export const SAFE_FIX_BY_CODE: ReadonlyMap<string, SafeFix> = new Map(
  SAFE_FIXES.map((f) => [f.code, f])
)

/**
 * Every issue code the doctor deliberately does NOT auto-fix, with the reason. The
 * reason falls in one of four buckets: `infra` (platform-wide; a fix is an ops action,
 * not a tenant repair), `ambiguous` (the safe action depends on intent a machine cannot
 * infer), `data-loss` (any automatic action risks destroying data), or `probe-failure`
 * (the check could not read its input, so there is nothing to fix). A code here is a
 * DELIBERATE decision, re-triaged whenever the census guard flags a new code.
 */
export const SURFACE_ONLY: ReadonlyMap<string, string> = new Map([
  // Platform infrastructure — an ops action, never a per-tenant auto-fix.
  ['lucid_unavailable', 'infra: Lucid/DB unreachable — an operator action, not a tenant fix'],
  ['membership_gate_missing', 'infra: no authorizer wired — a config decision for the host'],
  ['pool_near_saturation', 'infra: raise the pool ceiling — an ops capacity decision'],
  ['pool_pending_acquires', 'infra: connection demand exceeds the pool — an ops decision'],
  ['pgbouncer_mode_unknown', 'infra: PgBouncer pooling mode — an ops/config decision'],
  ['pgbouncer_pooling_mode', 'infra: reports the declared PgBouncer pooling mode — informational'],
  ['replica_points_at_primary', 'infra: replica config points at the primary — ops fix'],
  ['replica_not_in_recovery', 'infra: the configured replica is not a replica — ops fix'],
  ['replica_lag_critical', 'infra: replication lag — an ops/replication concern'],
  ['replica_lag_high', 'infra: replication lag — an ops/replication concern'],
  ['replica_unreachable', 'infra: the replica is unreachable — an ops concern'],
  ['app_role_superuser', 'infra: the app DB role is superuser — a security/ops hardening'],
  ['driver_contract', 'infra: the active driver does not support the probe — a config concern'],
  ['unknown_driver', 'infra: unrecognised isolation driver — a config concern'],
  [
    'vector_extension_missing',
    'infra: pgvector needs a privileged CREATE EXTENSION — an ops action',
  ],
  // Ambiguous — the correct action needs human intent.
  [
    'migration_corrupt',
    'ambiguous: a removed/rolled-back/squashed migration — review before acting',
  ],
  ['schema_orphan', 'ambiguous: a schema with no tenant row — could be retained or leaked'],
  [
    'lifecycle_deleted_without_timestamp',
    'ambiguous: status=deleted with no deletedAt — needs review',
  ],
  [
    'schema_retention_expired',
    'ambiguous: past-retention soft-deleted schema — a retention decision',
  ],
  ['queue_failed_jobs', 'ambiguous: failed jobs — retry vs discard is an operator decision'],
  ['queue_delayed_backlog', 'ambiguous: a delayed-job backlog — an operator decision'],
  ['queue_stalled', 'ambiguous: stalled jobs — an operator decision'],
  // Probe failure — the check could not read its input; nothing to fix.
  ['migration_drift_unavailable', 'probe-failure: could not compute the source migration set'],
  ['migration_drift_inspect_failed', 'probe-failure: could not read a tenant migration ledger'],
  ['migration_inspect_failed', 'probe-failure: could not inspect migration state'],
  ['metrics_freshness_unreadable', 'probe-failure: could not read the metrics table'],
  ['pg_stat_activity_unreadable', 'probe-failure: could not read pg_stat_activity'],
  ['queue_inspect_failed', 'probe-failure: could not inspect the queue'],
  ['vector_check_unreachable', 'probe-failure: could not reach the tenant to probe pgvector'],
])
