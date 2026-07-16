import PluginException, { type PluginExceptionContext } from './plugin_exception.js'

/** Attribution for a boot-phase plugin failure. */
export interface PluginBootContext extends PluginExceptionContext {
  /** The lifecycle phase that failed: a section resolver name, or `boot`/`ready`/`start`. */
  phase?: string
}

/**
 * Thrown when a plugin's `boot()`/`ready()`/`start()` hook (or one of its
 * declarative section resolvers) throws while the facade is wiring it.
 * Fail-closed: it aborts the deploy attributed to `{ plugin, phase }` rather than
 * leaving the plugin half-loaded. The original error rides as `cause`.
 */
export default class PluginBootException extends PluginException {
  static status = 500
  static code = 'E_PLUGIN_BOOT'

  readonly phase?: string | undefined

  constructor(message: string, context: PluginBootContext = {}) {
    super(message, { plugin: context.plugin, cause: context.cause })
    this.phase = context.phase
  }
}
