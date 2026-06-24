import type { SatelliteApiCompat } from './api_version.js'

/**
 * Per-surface extension contract versioning — the same idea as the Satellite
 * ABI ({@link ./api_version.js}) but one level down: an *extension* (a report,
 * a billing driver, an audit destination, …) declares the `contractVersion` it
 * was built against, and the satellite that hosts the surface compares it to
 * its own `CONTRACT_VERSION`.
 *
 * Semantics are deliberately identical to `checkSatelliteApiCompat` so authors
 * only learn one rule:
 *  - extension needs a NEWER contract than the surface provides → `fail` (the
 *    surface is missing API the extension relies on).
 *  - extension built for an OLDER contract → `warn` (the surface may have
 *    changed under it; it still runs, degraded).
 *  - equal → `ok`.
 *  - absent → `warn` (unversioned; compatibility unverified).
 *
 * This module is a sibling of `api_version.ts`, NOT a refactor of it: that
 * function's exact messages and signature are frozen by the `/sdk` ABI contract
 * test and must not change. Pure (no fs, no logger, no `app`) so a satellite's
 * registry can call it from its own bare unit runner.
 */
export type ContractCompatLevel = 'ok' | 'warn' | 'fail'

/** The bare three-way decision, without any message — the only logic shared. */
export function compareContractVersion(
  declared: number | undefined,
  current: number
): ContractCompatLevel {
  if (declared === undefined) return 'warn'
  if (declared > current) return 'fail'
  if (declared < current) return 'warn'
  return 'ok'
}

/**
 * Compare an extension's declared `contractVersion` against a surface's current
 * `CONTRACT_VERSION` and return a structured verdict. `label` names the
 * extension (e.g. its `name`) so the message points at the offender.
 */
export function checkContractCompat(
  declared: number | undefined,
  current: number,
  label: string
): SatelliteApiCompat {
  const level = compareContractVersion(declared, current)

  if (level === 'ok') return { level: 'ok' }

  if (declared === undefined) {
    return {
      level: 'warn',
      message:
        `${label} does not declare a contractVersion; compatibility with this ` +
        `surface's contract v${current} is unverified. Declare \`contractVersion: ${current}\`.`,
    }
  }

  if (level === 'fail') {
    return {
      level: 'fail',
      message:
        `${label} requires extension contract v${declared}, but this surface provides ` +
        `v${current}. Upgrade the satellite (or pin the extension to v${current}) to match.`,
    }
  }

  return {
    level: 'warn',
    message:
      `${label} was built for extension contract v${declared}; this surface is v${current}. ` +
      `It may rely on contract that has since changed — check the satellite's changelog.`,
  }
}

/**
 * Enforce {@link checkContractCompat} at registration time: throw on `fail`,
 * surface `warn` through `onWarn` (defaults to `console.warn`, the same
 * console fallback the rate-limit middleware uses), do nothing on `ok`.
 *
 * Synchronous and side-effect-light on purpose: registries call it inside their
 * `register()` (which is sync and must stay unit-testable without a booted
 * app), and validation happens at the point of registration — NOT in the
 * satellite provider `boot()`, because hosts register their extensions in their
 * own provider `boot()`, which can run after the satellite's.
 */
export function assertContractCompat(
  declared: number | undefined,
  current: number,
  label: string,
  onWarn: (message: string) => void = (m) => console.warn(`[lasagna] ${m}`)
): void {
  const result = checkContractCompat(declared, current, label)
  if (result.level === 'fail') throw new Error(result.message)
  if (result.level === 'warn') onWarn(result.message!)
}
