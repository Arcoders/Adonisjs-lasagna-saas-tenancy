import { assertSafeIdentifier } from '../services/isolation/identifier.js'

/**
 * Nominal (branded) types for the plugin surface. A value of one of these types
 * is PROOF that it already passed {@link assertSafeIdentifier}: the ONLY way to
 * obtain one is through the smart constructor below, which runs the guard before
 * minting. So anything that later gets interpolated into a Redis key, a BullMQ
 * `jobId`, a `Symbol`, or raw DDL takes a branded parameter, and the compiler
 * refuses a raw `string` that skipped the check.
 *
 * The single `as` assertion in {@link mint} is the ONE sanctioned type assertion
 * on this surface (the plan's E1 rule bans casts everywhere else). It is safe
 * precisely because `assertSafeIdentifier` has already thrown on anything that is
 * not `/^[a-zA-Z0-9_-]{1,63}$/` in canonical NFKC form.
 *
 * These are IDENTIFIER slugs (a plugin's short registration name, an authorizer
 * name, a capability key), NOT npm package names — a package name like
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

/**
 * The one sanctioned assertion site. Runs the identifier guard (which THROWS on
 * anything unsafe, emitting `guard.tenant_identifier`) and only then mints the
 * brand. A dedicated `guard.plugin_extension_identifier` isthmus event is layered
 * on in the E3 hardening pass; today the shared identifier guard carries it.
 */
function mint<B extends string>(raw: string, kind: string): Branded<B> {
  assertSafeIdentifier(raw, kind)
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
