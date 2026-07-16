import { AsyncLocalStorage } from 'node:async_hooks'
import type { PluginName } from '../sdk/brands.js'

/**
 * The identity + trust of the plugin whose code is currently executing. Core
 * enters this scope whenever it invokes a plugin-supplied callback (an
 * authorizer, a route middleware, a request macro today; a scheduled tick or a
 * data-change subscriber once those later phases land). Consumers deep in the request
 * path read it WITHOUT a container round-trip:
 *
 *   - the tenant adapter routes to a read-only connection when an UNTRUSTED
 *     plugin is on the stack (the Postgres-enforced firewall);
 *   - the sensitive-singleton proxies deny core access to untrusted plugins
 *     (labeled in-process friction, not a hard boundary).
 *
 * `trusted` is decided ONCE at scope entry (from the operator's
 * `TRUSTED_SATELLITES` allowlist) so per-query consumers never recompute it.
 * The store is immutable for the life of the scope, and scopes nest with normal
 * AsyncLocalStorage semantics (an inner scope shadows an outer one, which is
 * restored on exit).
 *
 * This is a module-level singleton on purpose: it lives on the per-query hot
 * path where a `container.make()` would be wrong, and a single module identity
 * means it can never be `new`-ed into an empty second instance (the failure the
 * stateful-singleton guard exists to prevent). It mirrors the `tenancy` facade.
 */
export interface PluginExecutionContext {
  /** The executing plugin's registration name (its `definePlugin({ name })` slug). */
  readonly plugin: PluginName
  /** Whether the plugin is on the operator's trusted allowlist. */
  readonly trusted: boolean
}

const als = new AsyncLocalStorage<PluginExecutionContext>()

/**
 * Run `fn` with `context` bound as the active plugin execution scope. Any code
 * (including async continuations) that calls {@link current} inside `fn` sees
 * it. Whatever `fn` returns (including a promise) is returned unchanged.
 */
function run<T>(context: PluginExecutionContext, fn: () => T): T {
  return als.run(context, fn)
}

/** The active plugin execution scope, or `undefined` outside one. Synchronous. */
function current(): PluginExecutionContext | undefined {
  return als.getStore()
}

/**
 * True when UNTRUSTED plugin code is on the stack, the single predicate the
 * read-only adapter and the core-access proxies gate on. False both outside any
 * plugin scope (core's own code, fully trusted) and inside a trusted plugin's
 * scope. Fail-closed by construction: anything core has not explicitly entered
 * as trusted plugin code is treated as core (trusted), and anything entered as
 * untrusted is contained.
 */
function untrustedActive(): boolean {
  const ctx = als.getStore()
  return ctx !== undefined && !ctx.trusted
}

export const pluginScope = {
  run,
  current,
  untrustedActive,
}
