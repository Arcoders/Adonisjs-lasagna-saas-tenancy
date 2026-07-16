/**
 * Git helpers for the D3 freshness signal. Everything degrades to null/empty on
 * failure (no git, a shallow clone, a path outside the work tree) so the tool
 * never crashes when history is unavailable; it simply emits no freshness signal.
 */
import { execFileSync } from 'node:child_process'

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** ISO commit date of the last commit touching `file` (repo-relative), or null. */
export function lastCommitDate(repoRoot: string, file: string): string | null {
  const out = git(repoRoot, ['log', '-1', '--format=%cI', '--', file])
  return out || null
}

/** Repo-relative paths changed in a git ref range (e.g. `origin/master...HEAD`). */
export function changedFiles(repoRoot: string, range: string): string[] {
  const out = git(repoRoot, ['diff', '--name-only', range])
  if (out === null) return []
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** True when git history is usable at all (so callers can label "unknown" vs "fresh"). */
export function hasGit(repoRoot: string): boolean {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true'
}
