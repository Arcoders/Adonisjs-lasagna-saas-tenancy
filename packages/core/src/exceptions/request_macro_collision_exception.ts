import PluginException from './plugin_exception.js'

/**
 * Thrown when a plugin registers a `request.<name>()` macro whose name is already
 * taken: by the built-in `tenant()` macro, another plugin's macro, or an
 * existing property on the request prototype. A 500 at boot: two macros under one
 * name would silently shadow each other, so we fail fast rather than let the last
 * registration win.
 */
export default class RequestMacroCollisionException extends PluginException {
  static status = 500
  static code = 'E_REQUEST_MACRO_COLLISION'
}
