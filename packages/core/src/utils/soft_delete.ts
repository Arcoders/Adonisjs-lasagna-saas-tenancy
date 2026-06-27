import type { DateTime } from 'luxon'

export const DEFAULT_SOFT_DELETE_RETENTION_DAYS = 30

/**
 * True when `deletedAt` is set and older than `retentionDays` from `now`.
 * Pure helper, decoupled from app/container — easy to test.
 */
export function isExpired(
  deletedAt: DateTime | null | undefined,
  retentionDays: number,
  now: number = Date.now()
): boolean {
  if (!deletedAt) return false
  const deletedMs = deletedAt.toMillis()
  if (!Number.isFinite(deletedMs)) return false
  const cutoff = now - retentionDays * 86400_000
  return deletedMs <= cutoff
}

/** Minimal shape `selectPurgeable` needs from a tenant. */
interface PurgeableTenant {
  isDeleted: boolean
  deletedAt: DateTime | null | undefined
}

/**
 * Choose which soft-deleted tenants `tenant:purge-expired` should drop. By
 * default only those past the retention window (the safe, scheduled path).
 *
 * With `includeOrphans`, EVERY soft-deleted tenant is selected regardless of
 * retention — the recovery path for an immediate `tenant:destroy` whose schema
 * drop failed AFTER the soft-delete committed: the tenant is unreachable but its
 * schema is orphaned, and waiting out the full retention window to reclaim it is
 * wrong. A soft-deleted tenant whose schema still exists IS the pending-purge
 * marker; `driver.destroy` is idempotent, so re-dropping an already-gone schema
 * is a harmless no-op.
 *
 * Pure (no app/container) so the selection — the part whose bug would either
 * skip a real orphan or purge a still-within-retention tenant early — is
 * unit-testable without a database.
 */
export function selectPurgeable<T extends PurgeableTenant>(
  tenants: T[],
  retentionDays: number,
  options: { includeOrphans?: boolean } = {},
  now: number = Date.now()
): T[] {
  return tenants.filter(
    (t) =>
      t.isDeleted && (options.includeOrphans === true || isExpired(t.deletedAt, retentionDays, now))
  )
}
