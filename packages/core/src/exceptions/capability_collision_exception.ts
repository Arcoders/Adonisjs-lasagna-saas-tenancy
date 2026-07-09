import PluginException from './plugin_exception.js'

/**
 * Thrown when two plugins `provide` a capability under the same key. A 500 at
 * boot: capabilities are a single-provider registry (a `consume(key)` must be
 * unambiguous), so a collision is a deploy-time conflict the operator resolves by
 * removing one of the plugins, not a last-writer-wins race.
 */
export default class CapabilityCollisionException extends PluginException {
  static status = 500
  static code = 'E_CAPABILITY_COLLISION'
}
