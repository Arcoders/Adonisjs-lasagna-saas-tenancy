/**
 * Integration-suite isolation backstop, generalized over named baselines.
 *
 * The integration runner boots the fixture app once, so every spec shares the
 * process-level singletons (the multitenancy config in [core] src/config.ts, the
 * tenant resolver registry in the container, the module-level resolution
 * caches). A spec that mutates one and fails to restore it (a throwing
 * `group.setup`, a missing teardown) leaks the mutation into later specs. Because
 * Japa runs spec files in an undefined order, the leak surfaces only on some
 * orderings: an intermittent, scattered failure that a re-run "fixes".
 *
 * Each {@link Baseline} names one piece of shared state and knows how to read,
 * compare, and restore it. This guard snapshots every baseline at the first
 * group and, after every group, restores any that drifted, naming the offending
 * group so its teardown can be fixed at the source.
 *
 * RULE (keep the list small): register a Baseline ONLY when a real spec mutates
 * that global state without restoring it (and fix that spec's teardown too). The
 * backstop is the safety net for a demonstrated leak, not a speculative snapshot
 * of every singleton. An un-covered leak still fails loudly and reproducibly,
 * because spec order is made deterministic (see spec_order.ts), so a new leak is
 * debuggable rather than flaky.
 *
 * Handlers are deliberately synchronous: Japa does not await the `group:start` /
 * `group:end` emits, so capture/compare/restore must complete inside the
 * synchronous emit. Any async work a baseline needs (e.g. resolving a container
 * singleton) must happen earlier, when the Baseline is constructed.
 */

export interface Baseline<T> {
  /** Human-facing name of the shared state this baseline guards. */
  name: string
  /** Read the current value of the shared state. May throw if not ready yet. */
  capture: () => T
  /** True when two captures are equal (identity for a frozen object, value for an array). */
  equals: (a: T, b: T) => boolean
  /** Re-install the boot baseline value. */
  restore: (baseline: T) => void
}

export interface BaselineGuard {
  /** Snapshot each baseline on the first group, before any spec mutates it. */
  onGroupStart(): void
  /**
   * After a group, restore every baseline the group left drifted.
   * Returns true when at least one leak was detected and corrected.
   */
  onGroupEnd(groupTitle: string): boolean
}

/**
 * Build a guard over a list of named baselines. The first `onGroupStart` that
 * can read a baseline snapshots it (a baseline whose `capture` throws because the
 * suite is not configured yet is retried on the next group). Each `onGroupEnd`
 * compares the current value against the snapshot and restores on drift.
 */
export function createBaselineGuards(
  baselines: ReadonlyArray<Baseline<unknown>>,
  warn: (message: string) => void
): BaselineGuard {
  const snapshots = new Map<string, { value: unknown }>()

  return {
    onGroupStart() {
      for (const baseline of baselines) {
        if (snapshots.has(baseline.name)) continue
        try {
          snapshots.set(baseline.name, { value: baseline.capture() })
        } catch {
          // Not ready yet (the suite is unconfigured); retry on the next group.
        }
      }
    },

    onGroupEnd(groupTitle) {
      let restoredAny = false
      for (const baseline of baselines) {
        const snapshot = snapshots.get(baseline.name)
        if (snapshot === undefined) continue
        let current: unknown
        try {
          current = baseline.capture()
        } catch {
          continue
        }
        if (baseline.equals(snapshot.value, current)) continue

        warn(
          `[testkit] integration isolation: group "${groupTitle}" left "${baseline.name}" ` +
            `drifted (a mutation without a matching restore). Restoring the boot baseline so the ` +
            `next spec is not poisoned. Fix the leaking group's teardown.`
        )
        baseline.restore(snapshot.value)
        restoredAny = true
      }
      return restoredAny
    },
  }
}
