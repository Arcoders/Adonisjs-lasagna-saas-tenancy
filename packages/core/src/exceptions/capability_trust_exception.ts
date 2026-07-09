import PluginException from './plugin_exception.js'

/**
 * Thrown when a SENSITIVE capability crosses the trust boundary: an untrusted
 * plugin tries to `provide` one (at boot, checked against the `TRUSTED_SATELLITES`
 * allowlist by name) or untrusted plugin code tries to `consume` one (at runtime,
 * checked against the active plugin execution scope). A 403.
 *
 * A capability is "sensitive" only when its provision opts in (`sensitive: true`) —
 * ordinary, freely-composable capabilities are unaffected. Like every S5 control
 * this is labeled friction (an installed plugin has full in-process reach); it
 * makes the trusted-vs-untrusted split explicit at the composition seam rather than
 * pretending a JS proxy is a sandbox. See `.github/SECURITY.md`.
 */
export default class CapabilityTrustException extends PluginException {
  static status = 403
  static code = 'E_CAPABILITY_TRUST'
}
