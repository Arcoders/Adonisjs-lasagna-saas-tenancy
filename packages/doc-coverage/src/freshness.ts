/**
 * The freshness checkpoint (RFC sections 6 and 8). D3 fires when a symbol's contract hash
 * changed since its linked doc was last reviewed. "Last reviewed" is recorded
 * here: a committed map of `<symbol-id>|<doc-page>` to the contract hash that was
 * current when a maintainer accepted that pairing. A comment-only source edit
 * never changes the contract hash, so it never trips freshness; a param / throws
 * / signature change does, until the doc is reviewed and the checkpoint refreshed
 * with `docs:doctor --update-freshness`. The file is sorted and path-free, so it
 * is byte-identical on every OS.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface FreshnessCheckpoint {
  version: number
  /** `<symbol-id>|<doc-page>` to the contract hash current at the last review. */
  reviewed: Record<string, string>
}

export const FRESHNESS_VERSION = 1

export function loadFreshness(path: string): FreshnessCheckpoint | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FreshnessCheckpoint
    if (raw.version !== FRESHNESS_VERSION) return null
    return raw
  } catch {
    return null
  }
}

export function saveFreshness(path: string, checkpoint: FreshnessCheckpoint): void {
  const sorted: FreshnessCheckpoint = {
    version: FRESHNESS_VERSION,
    reviewed: Object.fromEntries(
      Object.entries(checkpoint.reviewed).sort((a, b) => a[0].localeCompare(b[0]))
    ),
  }
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n')
}
