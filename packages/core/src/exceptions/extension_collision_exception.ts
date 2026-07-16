import PluginException from './plugin_exception.js'

/**
 * Thrown when two entries register under the same key in a single-source
 * extension registry (resolver, isolation driver, audit destination, webhook
 * transformer, feature-flag strategy, bootstrapper). A 500 at boot: a duplicate
 * key is a deploy-time conflict. A copy-paste name collision would otherwise
 * silently shadow the first registration and re-point behavior with no signal, so
 * it is resolved by renaming or removing one rather than last-writer-wins. The
 * `plugin` attribution carries the colliding entry's name.
 *
 * The capability, authorizer, and middleware surfaces keep their own richer
 * collision exceptions (`CapabilityCollisionException`, `PluginAuthorizerException`,
 * `PluginMiddlewareException`); this is the default for the rest of the family.
 */
export default class ExtensionCollisionException extends PluginException {
  static status = 500
  static code = 'E_EXTENSION_COLLISION'
}
