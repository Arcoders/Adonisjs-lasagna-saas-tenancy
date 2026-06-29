/**
 * Integration-suite isolation backstop for the multitenancy config singleton.
 *
 * The integration runner boots the fixture app once, so every spec shares the
 * module-level config singleton ([core] src/config.ts stashes it on a
 * `Symbol.for(...)` key). A spec that swaps the config with `setConfig()` and
 * then fails to restore it (a throwing `group.setup`, a missing teardown) leaks
 * the swap into later specs. Because Japa runs spec files in an undefined order,
 * the leak surfaces only on some orderings, an intermittent and scattered
 * failure that a re-run "fixes".
 *
 * This guard snapshots the boot config at the first group and, after every group,
 * restores the baseline if the group left it drifted, naming the offender so its
 * teardown can be fixed at the source. It is the harness-level guarantee that one
 * spec can never poison another through the config.
 *
 * It is deliberately synchronous: Japa does not await the `group:start` /
 * `group:end` emits, so the handlers must complete inside the synchronous emit.
 * Config restore is sync (`setConfig`), so that holds.
 */
export interface ConfigBaselineDeps<C> {
  /** Read the current config singleton. May throw if the suite is unconfigured. */
  getConfig: () => C
  /** Re-install a config object as the singleton (re-set is allowed outside production). */
  setConfig: (config: C) => void
  /** Emit a human-facing warning naming the leaking group. */
  warn: (message: string) => void
}

export interface ConfigBaselineGuard {
  /** Snapshot the boot baseline on the first group, before any spec mutates it. */
  onGroupStart(): void
  /**
   * After a group, restore the baseline if the group left the config swapped.
   * Returns true when a leak was detected and corrected, false otherwise.
   */
  onGroupEnd(groupTitle: string): boolean
}

export function createConfigBaselineGuard<C>(deps: ConfigBaselineDeps<C>): ConfigBaselineGuard {
  let baseline: C | undefined

  return {
    onGroupStart() {
      if (baseline !== undefined) return
      try {
        // First group fires before any spec setup, so this is the true boot config.
        baseline = deps.getConfig()
      } catch {
        // The suite is not configured yet; nothing to guard.
      }
    },

    onGroupEnd(groupTitle) {
      if (baseline === undefined) return false
      let current: C
      try {
        current = deps.getConfig()
      } catch {
        return false
      }
      // Identity check: a spec that restores correctly re-installs the same frozen
      // baseline object, so a difference means a real, un-restored swap.
      if (current === baseline) return false

      deps.warn(
        `[testkit] integration isolation: group "${groupTitle}" left the multitenancy config ` +
          `swapped (a setConfig without a matching restore). Restoring the boot baseline so the ` +
          `next spec is not poisoned. Fix the leaking group's teardown.`
      )
      deps.setConfig(baseline)
      return true
    },
  }
}
