import { isSafeIdentifier } from '../services/isolation/identifier.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'

/**
 * Nominal (branded) types for the plugin surface. A value of one of these types
 * is PROOF that it already passed the identifier guard ({@link isSafeIdentifier}):
 * the ONLY way to obtain one is through the smart constructor below, which runs
 * the guard before minting. So anything that later gets interpolated into a Redis
 * key, a BullMQ `jobId`, a `Symbol`, or raw DDL takes a branded parameter, and the
 * compiler refuses a raw `string` that skipped the check.
 *
 * The single `as` assertion in {@link mint} is the ONE sanctioned type assertion
 * on this surface (the plan bans casts everywhere else). It is safe
 * precisely because `isSafeIdentifier` has already returned false (and `mint` has
 * thrown) on anything that is not `/^[a-zA-Z0-9_-]{1,63}$/` in canonical NFKC form.
 *
 * These are IDENTIFIER slugs (a plugin's short registration name, an authorizer
 * name, a capability key), NOT npm package names. A package name like
 * `@adonisjs-lasagna/reporting` carries `@` and `/` and stays a plain `string`
 * used only in human-facing messages.
 */

declare const BRAND: unique symbol
type Branded<B extends string> = string & { readonly [BRAND]: B }

/** A plugin's short registration name (its `definePlugin({ name })` slug). */
export type PluginName = Branded<'PluginName'>
/** A registered authorizer's name. */
export type AuthorizerName = Branded<'AuthorizerName'>
/** A registered tenant middleware entry's name. */
export type MiddlewareName = Branded<'MiddlewareName'>
/** A registered `request.<name>()` macro's name. */
export type MacroName = Branded<'MacroName'>
/** A capability key in the `LasagnaCapabilities` registry (e.g. `email`, `search`). */
export type CapabilityKey = Branded<'CapabilityKey'>
/** A Lucid model / table identifier a plugin declares it observes (a `data_change` permission). */
export type ModelName = Branded<'ModelName'>
/** A registered tenant schedule's name. Interpolated into the native
 *  schedule id and the per-tenant dispatch `jobId`, so it must be a safe slug. */
export type ScheduleName = Branded<'ScheduleName'>

/**
 * The one sanctioned assertion site. Validates the raw string with the shared
 * identifier predicate and, on a reject, emits the dedicated plugin-surface guard
 * `guard.plugin_extension_identifier` (distinct from the tenant-DDL
 * `guard.tenant_identifier`, so an operator can tell a hostile plugin identifier
 * apart from a bad tenant id) and throws BEFORE minting the brand. The single `as`
 * below is reached only once the predicate has confirmed the value is safe.
 */
function mint<B extends string>(raw: string, kind: string): Branded<B> {
  if (!isSafeIdentifier(raw)) {
    emitIsthmusEvent('guard.plugin_extension_identifier', {
      metadata: { kind, value: String(raw).slice(0, 64) },
    })
    throw new Error(
      `Refusing to mint unsafe plugin ${kind} "${String(raw)}". ` +
        `Names must match /^[a-zA-Z0-9_-]{1,63}$/ in canonical (NFKC) form.`
    )
  }
  return raw as Branded<B>
}

export function pluginName(raw: string): PluginName {
  return mint<'PluginName'>(raw, 'plugin name')
}
export function authorizerName(raw: string): AuthorizerName {
  return mint<'AuthorizerName'>(raw, 'authorizer name')
}
export function middlewareName(raw: string): MiddlewareName {
  return mint<'MiddlewareName'>(raw, 'middleware name')
}
export function macroName(raw: string): MacroName {
  return mint<'MacroName'>(raw, 'macro name')
}
export function capabilityKey(raw: string): CapabilityKey {
  return mint<'CapabilityKey'>(raw, 'capability key')
}
export function modelName(raw: string): ModelName {
  return mint<'ModelName'>(raw, 'model name')
}
export function scheduleName(raw: string): ScheduleName {
  return mint<'ScheduleName'>(raw, 'schedule name')
}
