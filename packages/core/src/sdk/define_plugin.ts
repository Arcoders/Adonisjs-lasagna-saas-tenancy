import type { ApplicationService } from '@adonisjs/core/types'
import type { SatelliteProviderConstructor, SatelliteProviderContract } from './contract.js'
import type { TenantAuthorizerEntry } from '../services/authorizer_registry.js'
import type { TenantMiddlewareEntry } from '../services/tenant_middleware_registry.js'
import type { CapabilityProvision } from '../services/capability_registry.js'
import type { TenantSchedule } from '../services/tenant_scheduler_service.js'
import type { ProvisionExtensionSpec } from '../services/isolation/vector_provisioning.js'
import type { TenantRequestMacroSpec } from '../extensions/request.js'
import { pluginName, type PluginName } from './brands.js'
import type { PluginPermission } from './plugin_permissions.js'
import { assertNever } from './assert_never.js'
import { assertSatelliteApiCompatAtBoot } from './api_version.js'
import { assertPluginApiCompatAtBoot } from './plugin_api_version.js'
import PluginBootException from '../exceptions/plugin_boot_exception.js'

/**
 * The union of every entry a boot-phase section can yield. The `boot()`
 * dispatcher `switch`es over `kind` exhaustively (`default: assertNever`), so
 * ADDING a seam whose entry is not handled is a COMPILE error — the E1 closed-union
 * guarantee. Grows additively per lote (Lote A: the four request-path kinds; Lote B
 * adds schedule; C adds data-change).
 */
type PluginBootEntry =
  | TenantAuthorizerEntry
  | TenantMiddlewareEntry
  | TenantRequestMacroSpec
  | CapabilityProvision
  | TenantSchedule

/**
 * A declarative section of a {@link PluginSpec}. ALWAYS a function of the app
 * (never a bare value — the plan's obj#3 removes the value overload so the type
 * has one shape), so a section can read config or resolve a dependency lazily and
 * stay app.booted-safe until `boot()` actually runs it.
 */
export type PluginSection<T> = (app: ApplicationService) => T | Promise<T>

/**
 * The declarative shape a satellite author passes to {@link definePlugin}. It
 * composes the existing extension seams plus the new ones as typed sections, and
 * collapses the ABI ceremony (the two `assert*CompatAtBoot` calls) that every
 * hand-written provider repeats today.
 *
 * `PluginSpec` grows ADDITIVELY per lote — Lote A ships the request-path fields
 * (`authorizers`, and, as their seams land in this same lote, `middleware` /
 * `requestMacros` / `provides`); B and C add theirs. A field that has no seam yet
 * simply is not on the interface.
 */
export interface PluginSpec {
  /** Short registration slug (safe identifier). Distinct from the npm package name. */
  readonly name: string
  /** Optional human-facing version, purely informational. */
  readonly version?: string
  /** The Satellite ABI this plugin was built against (`package.json#lasagnaSatellite.satelliteApi`). */
  readonly satelliteApi: number
  /** The `definePlugin` facade contract this plugin was built against (independent of `satelliteApi`). */
  readonly pluginApiVersion?: number
  /** npm package name, used only in human-facing ABI messages. Defaults to `name`. */
  readonly packageName?: string

  /**
   * Sensitive capabilities this plugin declares it needs, populated ONLY through
   * the `permission.*` builders. Surfaced at install for operator consent (S1)
   * and cross-checked against `package.json#lasagnaSatellite.permissions` by the
   * `check-plugin-permissions` guard. Declaration is disclosure, not enforcement
   * (see {@link PluginPermission}); it must stay coherent with the manifest.
   */
  readonly permissions?: readonly PluginPermission[]

  /**
   * Set when the plugin ships native (`.node`) addons. A native addon evades the
   * worker's Node Permission Model, so `boot()` fails closed if this plugin runs
   * in a sandboxed worker (`--permission`) without `--allow-addons` (S4b). Keep it
   * in sync with `package.json#lasagnaSatellite.nativeAddons`.
   */
  readonly nativeAddons?: boolean

  // --- Lote A seams (request-path) ---
  /** Tenant-access authorizers, appended to the fail-closed authorizer chain (SEAM-3). */
  readonly authorizers?: PluginSection<readonly TenantAuthorizerEntry[]>
  /** Route middleware stacked onto tenant/central/universal groups (SEAM-2). */
  readonly middleware?: PluginSection<readonly TenantMiddlewareEntry[]>
  /** `request.<name>()` macros mirrored on the request (SEAM-4). */
  readonly requestMacros?: PluginSection<readonly TenantRequestMacroSpec[]>
  /** Capabilities this plugin provides for optional cross-plugin composition. */
  readonly provides?: PluginSection<readonly CapabilityProvision[]>

  // --- Lote B seams (workers) ---
  /** Periodic ticks that fan out over active tenants (SEAM-1). */
  readonly schedules?: PluginSection<readonly TenantSchedule[]>
  /** Postgres extensions installed into each tenant's storage on provision (SEAM-7). */
  readonly provisionExtensions?: PluginSection<readonly ProvisionExtensionSpec[]>

  // --- lifecycle escape hatches (map onto the provider phases) ---
  readonly bind?: (app: ApplicationService) => void | Promise<void>
  readonly boot?: (app: ApplicationService) => void | Promise<void>
  readonly ready?: (app: ApplicationService) => void | Promise<void>
  readonly start?: (app: ApplicationService) => void | Promise<void>
  readonly shutdown?: (app: ApplicationService) => void | Promise<void>
}

/**
 * Build a satellite provider from a declarative {@link PluginSpec}. Returns a
 * `SatelliteProviderConstructor` so a satellite's provider collapses to
 * `export default definePlugin({ ... })`.
 *
 * The returned class maps the spec onto the AdonisJS provider lifecycle:
 *  - `register()` runs the `bind` hook (bind your own singletons here).
 *  - `boot()` runs the ABI backstops, then wires every declarative section into
 *    its core registry (all present before core consumes them in `start()`),
 *    then the `boot` hook.
 *  - `start()` / `ready()` / `shutdown()` run their hooks.
 *
 * Any section resolver or lifecycle hook that throws is wrapped in a
 * {@link PluginBootException} attributed to `{ plugin, phase }` — fail-closed,
 * aborting the deploy rather than leaving the plugin half-loaded.
 *
 * This module is app.booted-safe (no static import of a booted-touching service);
 * registry classes are pulled in with a lazy `await import(...)` at `boot()` time.
 */
export function definePlugin(spec: PluginSpec): SatelliteProviderConstructor {
  // Validate the slug eagerly at definePlugin() call time (module load) so a bad
  // name fails fast at import, not at boot. packageName stays a plain string.
  const name: PluginName = pluginName(spec.name)
  const label = spec.packageName ?? spec.name

  return class LasagnaPlugin implements SatelliteProviderContract {
    constructor(protected app: ApplicationService) {}

    async register(): Promise<void> {
      await this.#runHook('register', spec.bind)
    }

    async boot(): Promise<void> {
      // ABI + facade-contract backstops. Fail-closed on a core too old (throws,
      // aborting the deploy before any section wires). configure gates ABI once
      // at install; these are the runtime backstop for a later core downgrade.
      assertSatelliteApiCompatAtBoot({ satelliteApi: spec.satelliteApi }, label)
      assertPluginApiCompatAtBoot(spec.pluginApiVersion, label)

      // S4b: a native-addon plugin cannot run in a Permission-Model worker without
      // --allow-addons. Inert in the API process (no --permission); aborts a
      // sandboxed worker deploy. No-op unless the plugin declares native addons.
      if (spec.nativeAddons) {
        const { assertNativeAddonsSandboxable } = await import('../services/worker_sandbox.js')
        assertNativeAddonsSandboxable(name)
      }

      for (const entry of await this.#collectBootEntries()) {
        await this.#registerEntry(entry)
      }

      await this.#registerProvisionExtensions()

      await this.#runHook('boot', spec.boot)
    }

    async start(): Promise<void> {
      await this.#runHook('start', spec.start)
    }

    async ready(): Promise<void> {
      await this.#runHook('ready', spec.ready)
    }

    async shutdown(): Promise<void> {
      await this.#runHook('shutdown', spec.shutdown)
    }

    /** Resolve every present boot-phase section into one flat entry list. */
    async #collectBootEntries(): Promise<PluginBootEntry[]> {
      const entries: PluginBootEntry[] = []
      if (spec.authorizers) {
        entries.push(...(await this.#resolveSection('authorizers', spec.authorizers)))
      }
      if (spec.middleware) {
        entries.push(...(await this.#resolveSection('middleware', spec.middleware)))
      }
      if (spec.requestMacros) {
        entries.push(...(await this.#resolveSection('requestMacros', spec.requestMacros)))
      }
      if (spec.provides) {
        entries.push(...(await this.#resolveSection('provides', spec.provides)))
      }
      if (spec.schedules) {
        entries.push(...(await this.#resolveSection('schedules', spec.schedules)))
      }
      return entries
    }

    /**
     * Route one entry to its seam. The `switch` is CLOSED: `default:
     * assertNever(entry)` makes an unhandled `kind` a compile error, so a new seam
     * cannot silently no-op. Registry classes (and the request-macro installer)
     * are imported lazily so this module stays app.booted-safe.
     */
    async #registerEntry(entry: PluginBootEntry): Promise<void> {
      switch (entry.kind) {
        case 'authorizer': {
          const { default: AuthorizerRegistry } = await import('../services/authorizer_registry.js')
          ;(await this.app.container.make(AuthorizerRegistry)).register(entry)
          return
        }
        case 'middleware': {
          const { default: TenantMiddlewareRegistry } =
            await import('../services/tenant_middleware_registry.js')
          ;(await this.app.container.make(TenantMiddlewareRegistry)).register(entry)
          return
        }
        case 'capability': {
          const { default: CapabilityRegistry } = await import('../services/capability_registry.js')
          // Thread the plugin's own name so the registry can allowlist-gate a
          // `sensitive` provision against TRUSTED_SATELLITES (S5). Ordinary
          // provisions ignore it.
          ;(await this.app.container.make(CapabilityRegistry)).register(entry, name)
          return
        }
        case 'requestMacro': {
          const { registerTenantRequestMacro } = await import('../extensions/request.js')
          registerTenantRequestMacro(entry)
          return
        }
        case 'schedule': {
          const { default: TenantSchedulerService } =
            await import('../services/tenant_scheduler_service.js')
          ;(await this.app.container.make(TenantSchedulerService)).register(entry)
          return
        }
        default:
          return assertNever(entry, 'plugin entry kind')
      }
    }

    /**
     * Register an `after('provision')` hook that installs each declared Postgres
     * extension into a newly-provisioned tenant's storage (SEAM-7). Identifiers are
     * validated HERE, at boot, so a typo'd / hostile extension name fails the deploy
     * rather than the first tenant provision. The hook is fail-open by the
     * HookRegistry after-hook contract (a throw is logged, not propagated), so a
     * per-tenant install failure surfaces without aborting the tenant's own
     * provisioning; the throw makes that failure visible in the logs.
     */
    async #registerProvisionExtensions(): Promise<void> {
      if (!spec.provisionExtensions) return
      const specs = await this.#resolveSection('provisionExtensions', spec.provisionExtensions)
      if (specs.length === 0) return
      try {
        const { assertSafeIdentifier } = await import('../services/isolation/identifier.js')
        for (const ext of specs) {
          assertSafeIdentifier(ext.name, 'extension name')
          if (ext.schema !== undefined) assertSafeIdentifier(ext.schema, 'extension schema')
        }
        const { provisionExtension } = await import('../services/isolation/vector_provisioning.js')
        const { default: HookRegistry } = await import('../services/hook_registry.js')
        const hooks = await this.app.container.make(HookRegistry)
        hooks.after('provision', async (ctx) => {
          for (const ext of specs) {
            const summary = await provisionExtension(ext, { tenantIds: [ctx.tenant.id] })
            if (summary.failed > 0) {
              throw new Error(
                `plugin "${name}": extension "${ext.name}" failed to provision for tenant ` +
                  `${ctx.tenant.id}`
              )
            }
          }
        })
      } catch (error) {
        throw new PluginBootException(`plugin "${name}" failed to register provisionExtensions`, {
          plugin: name,
          phase: 'provisionExtensions',
          cause: error,
        })
      }
    }

    /** Run a declarative section's factory, wrapping any throw as a boot failure. */
    async #resolveSection<T>(phase: string, section: PluginSection<T>): Promise<T> {
      try {
        return await section(this.app)
      } catch (error) {
        throw new PluginBootException(`plugin "${name}" section "${phase}" failed to resolve`, {
          plugin: name,
          phase,
          cause: error,
        })
      }
    }

    /** Run a lifecycle hook, wrapping any throw as an attributed boot failure. */
    async #runHook(
      phase: string,
      hook?: (app: ApplicationService) => void | Promise<void>
    ): Promise<void> {
      if (!hook) return
      try {
        await hook(this.app)
      } catch (error) {
        throw new PluginBootException(`plugin "${name}" ${phase}() hook failed`, {
          plugin: name,
          phase,
          cause: error,
        })
      }
    }
  }
}
