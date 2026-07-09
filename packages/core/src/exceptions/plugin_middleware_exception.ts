import PluginException from './plugin_exception.js'

/**
 * Thrown at REGISTRATION time when a tenant middleware is registered with an
 * invalid shape — a duplicate name, or an incompatible `contractVersion`. A 500
 * (an author/config error surfaced at boot). A middleware that throws at REQUEST
 * time is not this: it propagates through the router pipeline as the host's
 * exception handler decides (fail-closed on the request path).
 */
export default class PluginMiddlewareException extends PluginException {
  static status = 500
  static code = 'E_PLUGIN_MIDDLEWARE'
}
