import { Exception } from '@adonisjs/core/exceptions'

/** Attribution carried by every plugin-platform failure. */
export interface PluginExceptionContext {
  /** The plugin the failure is attributed to (its `definePlugin({ name })`), when known. */
  plugin?: string | undefined
  /** The underlying error, preserved as `cause` for logs. */
  cause?: unknown
}

/**
 * Base class for every failure originating in the plugin platform (the `/plugin`
 * facade and its seams). Subclasses set a specific `status`/`code`; this base
 * carries the offending plugin's name so a log line or an isthmus event can
 * attribute the fault. Never thrown directly — always a subclass, so the `code`
 * is specific (the E3 "no bare `Error` on the plugin surface" rule).
 */
export default class PluginException extends Exception {
  static status = 500
  static code = 'E_PLUGIN'

  readonly plugin?: string | undefined

  constructor(message: string, context: PluginExceptionContext = {}) {
    super(message, { cause: context.cause })
    this.plugin = context.plugin
  }
}
