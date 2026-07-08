import type { HttpRequest } from '@adonisjs/core/http'
import { authorizerName, middlewareName, macroName, capabilityKey } from './brands.js'
import type { LasagnaCapabilities } from './capabilities.js'
import {
  AUTHORIZER_CONTRACT_VERSION,
  type TenantAuthorizer,
  type TenantAuthorizerEntry,
} from '../services/authorizer_registry.js'
import {
  TENANT_MIDDLEWARE_CONTRACT_VERSION,
  type TenantMiddleware,
  type TenantMiddlewareScope,
  type TenantMiddlewareEntry,
} from '../services/tenant_middleware_registry.js'
import {
  CAPABILITY_CONTRACT_VERSION,
  type CapabilityProvision,
} from '../services/capability_registry.js'
import type { TenantRequestMacroSpec } from '../extensions/request.js'

/**
 * E8 — typed section builders. Each one is the ergonomic way to author a seam
 * entry: the author passes a plain `name` string and the callback, and the
 * builder (1) mints the branded name through its guard (`assertSafeIdentifier`
 * runs, so a hostile name throws here at authoring time), (2) stamps the `kind`
 * discriminant, and (3) defaults `contractVersion` to the surface constant the
 * SDK ships, so a builder-authored entry never trips the "undeclared
 * contractVersion" warning. The author never writes the raw discriminated object
 * or reaches for a minter by hand; the result is byte-compatible with the raw
 * shape, so `definePlugin` consumes it unchanged.
 */

/** Build a fail-closed tenant-access authorizer entry (SEAM-3). */
export function authorizer(spec: {
  readonly name: string
  readonly authorize: TenantAuthorizer
  /** Ascending run order; ties break by registration order. */
  readonly order?: number
  /** Override the declared contract version (defaults to the SDK's current one). */
  readonly contractVersion?: number
}): TenantAuthorizerEntry {
  return {
    kind: 'authorizer',
    name: authorizerName(spec.name),
    authorize: spec.authorize,
    contractVersion: spec.contractVersion ?? AUTHORIZER_CONTRACT_VERSION,
    ...(spec.order !== undefined ? { order: spec.order } : {}),
  }
}

/** Build a route-middleware entry stacked onto a tenant/central/universal scope (SEAM-2). */
export function middleware(spec: {
  readonly name: string
  readonly middleware: TenantMiddleware
  /** Route scope to attach to. Defaults to `tenant`. */
  readonly scope?: TenantMiddlewareScope
  /** Ascending run order within a scope; ties break by registration order. */
  readonly order?: number
  /** Override the declared contract version (defaults to the SDK's current one). */
  readonly contractVersion?: number
}): TenantMiddlewareEntry {
  return {
    kind: 'middleware',
    name: middlewareName(spec.name),
    middleware: spec.middleware,
    contractVersion: spec.contractVersion ?? TENANT_MIDDLEWARE_CONTRACT_VERSION,
    ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
    ...(spec.order !== undefined ? { order: spec.order } : {}),
  }
}

/** Build a `request.<name>()` macro spec (SEAM-4). The resolved type `T` flows
 *  through so `request.<name>()` is typed at the augmentation site. */
export function requestMacro<T>(spec: {
  readonly name: string
  readonly resolve: (request: HttpRequest) => T | Promise<T>
  /** Fail closed (throw) if no tenant is resolved when the macro is read. */
  readonly requireTenant?: boolean
}): TenantRequestMacroSpec<T> {
  return {
    kind: 'requestMacro',
    name: macroName(spec.name),
    resolve: spec.resolve,
    ...(spec.requireTenant !== undefined ? { requireTenant: spec.requireTenant } : {}),
  }
}

/**
 * Build a capability provision for the registry. The typed overload keys the
 * `api` on {@link LasagnaCapabilities}, so `defineCapability({ name: 'email', api })`
 * checks `api` against the augmented `email` type; an unaugmented / opaque key
 * falls through to the `unknown` overload.
 */
export function defineCapability<K extends keyof LasagnaCapabilities & string>(spec: {
  readonly name: K
  readonly api: LasagnaCapabilities[K]
  readonly sensitive?: boolean
  readonly contractVersion?: number
}): CapabilityProvision
export function defineCapability(spec: {
  readonly name: string
  readonly api: unknown
  readonly sensitive?: boolean
  readonly contractVersion?: number
}): CapabilityProvision
export function defineCapability(spec: {
  readonly name: string
  readonly api: unknown
  readonly sensitive?: boolean
  readonly contractVersion?: number
}): CapabilityProvision {
  return {
    kind: 'capability',
    name: capabilityKey(spec.name),
    api: spec.api,
    // Only set when opted in, so an ordinary provision stays `{ sensitive: undefined }`-free.
    ...(spec.sensitive === true ? { sensitive: true } : {}),
    contractVersion: spec.contractVersion ?? CAPABILITY_CONTRACT_VERSION,
  }
}
