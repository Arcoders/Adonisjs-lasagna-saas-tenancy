import { checkSatelliteApiCompat, SATELLITE_API_VERSION } from '../sdk/api_version.js'
import type { DiagnosisIssue } from './doctor/types.js'

/** A satellite as the plugin doctor sees it, the slice of its manifest that matters. */
export interface PluginDoctorSatellite {
  readonly packageName: string
  /** The manifest `name` (the slug the TRUSTED_SATELLITES allowlist matches). */
  readonly name: string
  readonly satelliteApi?: number | undefined
  /** Canonical wire-form permissions the manifest declares. */
  readonly permissions?: readonly string[] | undefined
  readonly nativeAddons?: boolean | undefined
}

/** The deployed posture the doctor diagnoses: installed satellites + trust/firewall config. */
export interface PluginDoctorInput {
  readonly satellites: readonly PluginDoctorSatellite[]
  /** The operator's TRUSTED_SATELLITES allowlist (plugin names). */
  readonly trusted: readonly string[]
  /** Whether `config.plugins.readOnly` is set (the Postgres firewall). */
  readonly readOnlyConfigured: boolean
  /** Core's Satellite ABI; injectable for tests, defaults to {@link SATELLITE_API_VERSION}. */
  readonly coreSatelliteApi?: number
}

export interface PluginDoctorReport {
  readonly issues: readonly DiagnosisIssue[]
  readonly totals: { readonly info: number; readonly warn: number; readonly error: number }
}

/**
 * A PARALLEL doctor for the plugin/satellite PLATFORM posture, NOT the tenant-state
 * `DoctorService` (whose per-tenant DB checks are the wrong shape here). Pure and
 * stateless: it maps the installed satellite manifests plus the runtime trust and
 * firewall configuration to actionable diagnoses, with no booted app and no DB. The
 * `plugin:doctor` command gathers the input (discoverSatellites + getConfig +
 * TRUSTED_SATELLITES) and renders the report.
 *
 * It deliberately does NOT introspect plugin SPECS: those are not available at
 * runtime without loading providers, and the manifest↔spec coherence plus the
 * "declared permissions ⊇ seams used" checks are the CI guard's job
 * (`check-plugin-permissions`). This doctor is about the DEPLOYED posture an operator
 * can see and act on: ABI drift, native-addon sandbox risk, a stale trust allowlist,
 * a missing read-only firewall, and which plugins hold declared (consent-gated)
 * permissions.
 */
export default class PluginDoctorService {
  run(input: PluginDoctorInput): PluginDoctorReport {
    const issues: DiagnosisIssue[] = [
      ...this.#abi(input),
      ...this.#nativeAddons(input),
      ...this.#trustList(input),
      ...this.#readOnlyPosture(input),
      ...this.#declaredPermissions(input),
    ]
    if (issues.length === 0) {
      issues.push({
        code: 'plugin_platform_ok',
        severity: 'info',
        message: `${input.satellites.length} installed satellite(s); no plugin-platform posture issue found.`,
      })
    }
    return {
      issues,
      totals: {
        info: issues.filter((i) => i.severity === 'info').length,
        warn: issues.filter((i) => i.severity === 'warn').length,
        error: issues.filter((i) => i.severity === 'error').length,
      },
    }
  }

  /** Each satellite's declared Satellite ABI against this core's. A fail is an error. */
  #abi(input: PluginDoctorInput): DiagnosisIssue[] {
    const core = input.coreSatelliteApi ?? SATELLITE_API_VERSION
    const out: DiagnosisIssue[] = []
    for (const sat of input.satellites) {
      const compat = checkSatelliteApiCompat(
        sat.satelliteApi !== undefined ? { satelliteApi: sat.satelliteApi } : {},
        sat.packageName,
        core
      )
      if (compat.level === 'fail') {
        out.push({
          code: 'plugin_abi_incompatible',
          severity: 'error',
          message: compat.message,
          meta: { package: sat.packageName },
        })
      } else if (compat.level === 'warn') {
        out.push({
          code: 'plugin_abi_unverified',
          severity: 'warn',
          message: compat.message,
          meta: { package: sat.packageName },
        })
      }
    }
    return out
  }

  /** A native-addon satellite cannot be sandboxed by the worker Permission Model. */
  #nativeAddons(input: PluginDoctorInput): DiagnosisIssue[] {
    return input.satellites
      .filter((s) => s.nativeAddons === true)
      .map((s) => ({
        code: 'plugin_native_addons',
        severity: 'warn' as const,
        message:
          `${s.packageName} ships native addons — it cannot be sandboxed by the worker ` +
          `Permission Model and runs with full privilege regardless of the trust list. Contain ` +
          `it via the read-only role, the container network policy, and manual review.`,
        meta: { package: s.packageName },
      }))
  }

  /** A TRUSTED_SATELLITES entry matching no installed satellite name is dead/typo'd. */
  #trustList(input: PluginDoctorInput): DiagnosisIssue[] {
    const names = new Set(input.satellites.map((s) => s.name))
    return input.trusted
      .filter((t) => !names.has(t))
      .map((t) => ({
        code: 'plugin_trust_dead_entry',
        severity: 'warn' as const,
        message:
          `TRUSTED_SATELLITES lists "${t}", which matches no installed satellite name — a typo ` +
          `or a stale entry grants trust to nothing (or silently drops it after a rename).`,
        meta: { name: t },
      }))
  }

  /** Untrusted plugins share the app DB role unless the read-only firewall is set. */
  #readOnlyPosture(input: PluginDoctorInput): DiagnosisIssue[] {
    if (input.satellites.length === 0 || input.readOnlyConfigured) return []
    const untrusted = input.satellites.filter((s) => !input.trusted.includes(s.name))
    if (untrusted.length === 0) return []
    return [
      {
        code: 'plugin_read_only_unconfigured',
        severity: 'warn',
        message:
          `${untrusted.length} installed satellite(s) are not on TRUSTED_SATELLITES, but ` +
          `plugins.readOnly is not configured — untrusted plugin code shares the app DB role ` +
          `(in-process friction only). Configure the read-only role for the Postgres-enforced ` +
          `firewall (S3).`,
        meta: { untrusted: untrusted.map((s) => s.name) },
      },
    ]
  }

  /**
   * Standing disclosure of the declared permissions the installed satellites hold.
   * Every permission kind in the model (`scheduler`, `data_change:<Model>`,
   * `network:external`, `db:write`) is a sensitive, consent-gated capability, so ALL
   * of them are surfaced. Narrowing to a subset would let a plugin holding, say,
   * `data_change:User` (observe every write to the tenant's User model) read as clean.
   */
  #declaredPermissions(input: PluginDoctorInput): DiagnosisIssue[] {
    const out: DiagnosisIssue[] = []
    for (const sat of input.satellites) {
      const declared = sat.permissions ?? []
      if (declared.length > 0) {
        out.push({
          code: 'plugin_declared_permissions',
          severity: 'info',
          message: `${sat.packageName} holds declared permission(s): ${declared.join(', ')} (consented at install).`,
          meta: { package: sat.packageName, permissions: [...declared] },
        })
      }
    }
    return out
  }
}
