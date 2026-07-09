import PluginException from './plugin_exception.js'

/**
 * Thrown at REGISTRATION time when an authorizer is registered with an invalid
 * shape — a duplicate name, or an incompatible `contractVersion`. It is a 500 (an
 * author/config error surfaced at boot), deliberately distinct from a runtime
 * DENY: a registered authorizer that returns `{ allow: false }` or throws
 * produces a 403 `TenantAccessForbiddenException` (fail-closed), never this.
 */
export default class PluginAuthorizerException extends PluginException {
  static status = 500
  static code = 'E_PLUGIN_AUTHORIZER'
}
