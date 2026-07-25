import type { TenantStatus } from '../../types/contracts.js'
import type { TenantLifecycleDisposition } from '../../middleware/tenant_lifecycle_disposition.js'

/**
 * The composite tenant-state space, as DATA — retiring the phantom "row N of the state
 * matrix" comments that used to gesture at a table that lived only in prose.
 *
 * A tenant's observable state is more than its `status`: it is the product of `status`,
 * the soft-delete axis (`deletedAt`), and its storage/ledger reality (schema present?
 * migration ledger present? at head?). Each row here records a reachable composite, the
 * doctor diagnosis it should produce (or `healthy`), the check that owns it, and the
 * request-path disposition.
 *
 * What the completeness spec MACHINE-ENFORCES: every `TENANT_STATUSES` value appears as
 * some row's status; every row's `disposition` equals `tenantLifecycleDisposition` (so
 * the matrix and the live floor can never disagree); every non-healthy row is owned by a
 * registered check and names a known code. It does NOT prove that every composite
 * (status × deletedAt × schema × ledger) is present — this table is a curated,
 * hand-maintained map of the notable reachable composites, not an exhaustively-generated
 * one. Add a row when a new composite maps to a distinct diagnosis.
 */
export interface TenantStateRow {
  /** Stable id, referenced from code comments instead of a brittle "row N". */
  id: string
  status: TenantStatus
  /** Whether `deletedAt` is set (the independent soft-delete axis). */
  deletedAt: boolean
  /** Whether the tenant's per-tenant schema physically exists. */
  schemaExists: boolean
  /** Whether the migration ledger (`adonis_schema`) exists. */
  ledgerPresent: boolean
  /** Whether the ledger matches the source tree (names present + at head). */
  ledgerAtHead: boolean
  /** The diagnosis this composite should produce, or `healthy`. */
  expected: 'healthy' | { code: string; owningCheck: string }
  /** The request-path floor disposition (asserted == tenantLifecycleDisposition(row)). */
  disposition: TenantLifecycleDisposition
  note: string
}

export const TENANT_STATE_MATRIX: readonly TenantStateRow[] = [
  {
    id: 'active_healthy',
    status: 'active',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: true,
    expected: 'healthy',
    disposition: 'serve',
    note: 'Fully provisioned, migrated, at head — served normally.',
  },
  {
    id: 'active_behind',
    status: 'active',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: false,
    expected: { code: 'migration_behind', owningCheck: 'migration_drift' },
    disposition: 'serve',
    note: 'Behind head after a deploy or restore; fixable → heal applies the pending migrations.',
  },
  {
    id: 'active_relocated',
    status: 'active',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: false,
    expected: { code: 'migration_relocated', owningCheck: 'migration_drift' },
    disposition: 'serve',
    note: 'Ledger holds an inlined legacy name superseded by a satellite migration; the object exists → --reconcile-ledger (zero DDL). Heal would collide (B0 net).',
  },
  {
    id: 'active_corrupt',
    status: 'active',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: false,
    expected: { code: 'migration_corrupt', owningCheck: 'migration_drift' },
    disposition: 'serve',
    note: 'A ledger name with no source file (removed/rolled-back/squashed) — surface only, ambiguous.',
  },
  {
    id: 'active_never_migrated',
    status: 'active',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: { code: 'migrations_never_ran', owningCheck: 'migration_state' },
    disposition: 'serve',
    note: 'Active but no ledger (the carivo class); fixable → heal migrates from scratch.',
  },
  {
    id: 'active_no_schema',
    status: 'active',
    deletedAt: false,
    schemaExists: false,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: { code: 'schema_missing', owningCheck: 'schema_drift' },
    disposition: 'serve',
    note: 'Active but the schema is absent; fixable → heal provisions + migrates.',
  },
  {
    id: 'active_soft_deleted_divergence',
    status: 'active',
    deletedAt: true,
    schemaExists: false,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: { code: 'lifecycle_status_divergence', owningCheck: 'tenant_lifecycle' },
    disposition: 'reject-suspended',
    note: 'deletedAt set but status left active (the Atlas Rent class); fixable → reconcile status to deleted. Soft-delete axis rejects it at the floor.',
  },
  {
    id: 'suspended_healthy',
    status: 'suspended',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: true,
    expected: 'healthy',
    disposition: 'reject-suspended',
    note: 'Deliberately suspended; storage intact. Suspension is intentional, not a fault.',
  },
  {
    id: 'provisioning_recent',
    status: 'provisioning',
    deletedAt: false,
    schemaExists: false,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: 'healthy',
    disposition: 'reject-not-ready',
    note: 'Mid-provision, recently created; no issue (schema_drift skips provisioning to avoid a false 503).',
  },
  {
    id: 'provisioning_stalled',
    status: 'provisioning',
    deletedAt: false,
    schemaExists: false,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: { code: 'provisioning_stalled', owningCheck: 'provisioning_stalled' },
    disposition: 'reject-not-ready',
    note: 'Stuck in provisioning past the threshold; fixable → mark failed (a rise: failed is heal-recoverable).',
  },
  {
    id: 'failed_recoverable',
    status: 'failed',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: false,
    expected: { code: 'tenant_failed', owningCheck: 'failed_tenants' },
    disposition: 'reject-not-ready',
    note: 'Quarantined; fixable → heal re-provisions/migrates and returns it to active (the healer failed→active recovery references this row).',
  },
  {
    id: 'deleted_healthy',
    status: 'deleted',
    deletedAt: true,
    schemaExists: false,
    ledgerPresent: false,
    ledgerAtHead: false,
    expected: 'healthy',
    disposition: 'reject-suspended',
    note: 'Soft-deleted within retention; schema correctly dropped. Consistent terminal state.',
  },
  {
    id: 'deleted_retention_expired',
    status: 'deleted',
    deletedAt: true,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: true,
    expected: { code: 'schema_retention_expired', owningCheck: 'tenant_lifecycle' },
    disposition: 'reject-suspended',
    note: 'Soft-deleted past retention with the schema still retained; surface only (a retention decision).',
  },
  {
    id: 'deleted_without_timestamp',
    status: 'deleted',
    deletedAt: false,
    schemaExists: true,
    ledgerPresent: true,
    ledgerAtHead: true,
    expected: { code: 'lifecycle_deleted_without_timestamp', owningCheck: 'tenant_lifecycle' },
    disposition: 'reject-suspended',
    note: 'status=deleted but deletedAt null (an Invariant-A violation); surface only. The deleted status still rejects it at the floor (the deliberate hardening).',
  },
]

export function tenantStateRow(id: string): TenantStateRow | undefined {
  return TENANT_STATE_MATRIX.find((r) => r.id === id)
}
