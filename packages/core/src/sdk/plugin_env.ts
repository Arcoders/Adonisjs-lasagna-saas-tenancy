import { assertSafeIdentifier } from '../services/isolation/identifier.js'
import { pluginName, type PluginName } from './brands.js'

/**
 * The operator's trusted-plugin allowlist, read once from the `TRUSTED_SATELLITES`
 * environment variable. This is the SINGLE source of the trust boundary the
 * in-process friction gates on: a plugin whose registration name appears here is
 * "trusted" (it runs with the same reach as core), everything else is "untrusted"
 * (the core-access proxies deny it and the read-only Postgres route contains it).
 *
 * The value is a comma- and/or whitespace-separated list of plugin names, e.g.
 * `TRUSTED_SATELLITES="reporting, analytics search"`. Every entry is minted through
 * {@link pluginName} (the same identifier guard the plugin surface uses everywhere),
 * so a malformed entry can never smuggle an unsafe token into the allowlist: it is
 * DROPPED, loudly nowhere but harmlessly (an untrusted default is fail-closed).
 *
 * Reading env for a SECURITY allowlist goes through here and nowhere else (the
 * "nada cableado" rule): no other module touches `process.env.TRUSTED_SATELLITES`
 * raw. The result is memoized on the raw env string, so a process reads+parses it
 * once, while a test that reassigns the variable transparently gets a fresh parse
 * (the memo key changed) with no reset seam to remember.
 */
const TRUSTED_SATELLITES_ENV = 'TRUSTED_SATELLITES'

let memo: { raw: string; names: readonly PluginName[] } | undefined

function parse(raw: string): readonly PluginName[] {
  const names: PluginName[] = []
  for (const token of raw.split(/[\s,]+/)) {
    const trimmed = token.trim()
    if (trimmed === '') continue
    try {
      names.push(pluginName(trimmed))
    } catch {
      // Drop a malformed entry rather than fail the process: an operator typo in
      // the allowlist must not brick the deploy, and the fail-closed default
      // (an absent entry is untrusted) means a dropped entry can only REMOVE reach, never
      // grant it. The minter already emitted `guard.plugin_extension_identifier` on
      // the reject, so the drop is observable, not silent.
    }
  }
  return names
}

/**
 * The current trusted-plugin allowlist as branded names. Empty (nothing trusted)
 * when `TRUSTED_SATELLITES` is unset or blank, the fail-closed default.
 */
export function trustedSatellites(): readonly PluginName[] {
  const raw = process.env[TRUSTED_SATELLITES_ENV] ?? ''
  if (memo?.raw !== raw) memo = { raw, names: parse(raw) }
  return memo.names
}

/**
 * Whether `name` is on the operator's trusted allowlist. Total and fail-closed:
 * an unset allowlist, or a name not on it, is UNTRUSTED. Accepts a plain string
 * (canonicalized through the identifier guard before comparison) so a caller with
 * a raw name (the register-side capability trust check, which runs at boot with
 * no execution scope) can ask without minting a brand first.
 */
export function isTrustedSatellite(name: PluginName | string): boolean {
  let canonical: string
  try {
    assertSafeIdentifier(name, 'plugin name')
    canonical = name
  } catch {
    // An unsafe name is, by construction, not on the (safe-only) allowlist.
    return false
  }
  return trustedSatellites().some((trusted) => trusted === canonical)
}
