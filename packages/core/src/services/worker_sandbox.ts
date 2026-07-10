import PluginBootException from '../exceptions/plugin_boot_exception.js'

/**
 * The current process's Node Permission Model posture. Background plugin code
 * (the scheduled and data-change phases) runs in a dedicated worker the operator
 * launches with `--permission`
 * to sandbox filesystem/network/addon access. The API process is NOT sandboxed,
 * so anything derived from this in the API process is inert.
 */
export interface WorkerSandboxState {
  /** The process runs under the Node Permission Model (`node --permission`). */
  readonly permissionEnabled: boolean
  /** Native (`.node`) addons are permitted (`--allow-addons`). */
  readonly allowsAddons: boolean
}

/** Pure: derive the sandbox posture from a process's argv. */
export function parseWorkerSandboxState(execArgv: readonly string[]): WorkerSandboxState {
  return {
    permissionEnabled: execArgv.includes('--permission'),
    allowsAddons: execArgv.includes('--allow-addons'),
  }
}

/**
 * The current process's posture, read ONCE at module load so a per-boot
 * re-read can't drift. In the API process `--permission` is absent, so the
 * native-addon boot-check is inert there; it only bites inside a worker launched
 * under the Permission Model.
 */
export const WORKER_SANDBOX_STATE: WorkerSandboxState = parseWorkerSandboxState(process.execArgv)

/**
 * The base Node Permission Model flag the plugin worker is launched with. The
 * filesystem allow-lists (`--allow-fs-read` / `--allow-fs-write`) are host-specific
 * (app build dir, tmp, CA bundle) and are documented in SECURITY.md rather than
 * hard-coded here; native addons are intentionally NOT allowed by default (a
 * plugin needing them must opt in AND be treated as fully trusted, see
 * {@link assertNativeAddonsSandboxable}).
 */
export const NODE_SANDBOX_FLAGS = ['--permission'] as const

/**
 * Boot-time native-addon guard. A native (`.node`) addon evades the Node
 * Permission Model entirely, so a plugin that ships one cannot run in a sandboxed
 * worker. If the CURRENT process is sandboxed (`--permission`) WITHOUT
 * `--allow-addons` and the plugin declares native addons, abort the deploy: the
 * operator must drop the native dependency or launch the worker with
 * `--allow-addons` (accepting the plugin is then fully trusted, its containment
 * resting on the read-only DB role and the network policy). Inert in the
 * non-sandboxed API process, and inert for a plugin with no native addons.
 */
export function assertNativeAddonsSandboxable(
  plugin: string,
  state: WorkerSandboxState = WORKER_SANDBOX_STATE
): void {
  if (state.permissionEnabled && !state.allowsAddons) {
    throw new PluginBootException(
      `plugin "${plugin}" declares native addons, but this worker runs under the Node ` +
        `Permission Model without --allow-addons, which a native addon cannot load. Either drop ` +
        `the native dependency or launch the worker with --allow-addons (and treat the plugin as ` +
        `fully trusted).`,
      { plugin, phase: 'nativeAddons' }
    )
  }
}
