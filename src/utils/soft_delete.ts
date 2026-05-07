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
