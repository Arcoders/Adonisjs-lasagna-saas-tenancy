import type { HttpContext } from '@adonisjs/core/http'
import ExtensionRegistry from './extension_registry.js'
import type { AuthorizerName } from '../sdk/brands.js'
import type { TenantModelContract } from '../types/contracts.js'
import type { TenantAccessAuthorizer } from '../types/config.js'
import PluginAuthorizerException from '../exceptions/plugin_authorizer_exception.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { executeExtension, ExtensionTimeoutError } from './extensions/execute_extension.js'

/**
 * Default response deadline for a single plugin authorizer. A hung authorizer
 * must not hang the request: past this it is treated as a DENY (fail-closed).
 * This is a DEADLINE, not cancellation (see `execute_extension.ts`). A
 * non-cooperative authorizer keeps running in the background; the caller is
 * unblocked with a 403. Overridable per deployment via the config knob
 * `plugins.limits.authorizerDeadlineMs`, which `TenantGuardMiddleware` threads
 * into {@link AuthorizerRegistry.authorizeAll}; this constant is the fallback.
 */
export const AUTHORIZER_DEADLINE_MS = 1000

/**
 * The authorizer-chain contract version: the shape of {@link TenantAuthorizerEntry}
 * and {@link AuthorizerDecision}. Bump as a MAJOR for a backward-incompatible
 * change. INDEPENDENT of `satelliteApi`, the facade `pluginApiVersion`, and the
 * published version (a host-pluggable security surface earns its own constant).
 */
export const AUTHORIZER_CONTRACT_VERSION = 1

/**
 * A typed authorize decision. `throw` is NOT part of the public contract: the
 * runner converts a thrown authorizer to a DENY internally (fail-closed), so an
 * author's bug fails safe without them ever modeling `throw` as a control-flow
 * channel. A deny may carry a `reason` for logs/audit; it is never surfaced to
 * the client (the middleware maps every deny to an opaque 403).
 */
export type AuthorizerDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason?: string }

/** The decision function a plugin author registers. */
export type TenantAuthorizer = (
  ctx: HttpContext,
  tenant: TenantModelContract
) => AuthorizerDecision | Promise<AuthorizerDecision>

/**
 * A registered authorizer. Discriminated by `kind` so the `definePlugin`
 * boot dispatcher can `switch` over sections exhaustively; all fields are
 * `readonly`. `name` is branded: minted via `authorizerName()`, which ran
 * `assertSafeIdentifier`, so a raw string cannot reach this slot.
 */
export interface TenantAuthorizerEntry {
  readonly kind: 'authorizer'
  readonly name: AuthorizerName
  readonly authorize: TenantAuthorizer
  /** Contract version this authorizer was built against (see {@link AUTHORIZER_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  /** Ascending run order; ties break by registration order. Defaults to 0. */
  readonly order?: number
}

/**
 * Registry + runner for the tenant-access authorizer chain. Bound as a container
 * singleton by `MultitenancyProvider`; plugins register entries in their
 * `boot()`. Map-backed (stateful): resolve via `container.make`, never `new`.
 *
 * The chain is fail-CLOSED and ADDITIVE. It runs the host's config-level
 * `authorizeTenantAccess` FIRST, then every registered authorizer; ANY
 * false-or-throw denies. An EMPTY registry with NO config callback allows,
 * byte-identical to the pre-seam behavior. A registered authorizer is purely
 * additive: it does NOT satisfy the `authorizeTenantAccess` membership-gate
 * signal (the boot warning + doctor check stay bound to the config callback), so
 * a plugin can never silently mask a missing IDOR gate.
 */
export default class AuthorizerRegistry extends ExtensionRegistry<
  AuthorizerName,
  TenantAuthorizerEntry
> {
  protected readonly surfaceLabel = 'authorizer'

  protected override get surfaceContractVersion(): number {
    return AUTHORIZER_CONTRACT_VERSION
  }

  protected override collisionError(name: AuthorizerName): Error {
    return new PluginAuthorizerException(`An authorizer named "${name}" is already registered.`, {
      plugin: name,
    })
  }

  register(entry: TenantAuthorizerEntry): this {
    const name = this.assertRegistrable(entry)
    this.entries.set(name, entry)
    return this
  }

  list(): readonly AuthorizerName[] {
    return [...this.entries.keys()]
  }

  /**
   * Run the full chain for one request. The config `authorizeTenantAccess`
   * callback runs FIRST (if any), then every registered authorizer in ascending
   * `order` (ties by registration order). The FIRST deny short-circuits and is
   * returned; a thrown authorizer is logged (fail-closed) and treated as a deny.
   * Reaching the end with no deny allows. Empty chain with no config callback allows.
   *
   * (The `~1s` deadline-to-deny `executeExtension` wrap and the isthmus/metric
   * emission are layered on in a later hardening pass; the fail-closed deny
   * behavior below is the load-bearing part and is what the unit specs pin.)
   */
  async authorizeAll(
    ctx: HttpContext,
    tenant: TenantModelContract,
    configAuthorizer?: TenantAccessAuthorizer,
    deadlineMs: number = AUTHORIZER_DEADLINE_MS
  ): Promise<AuthorizerDecision> {
    if (configAuthorizer) {
      let allowed: boolean
      try {
        allowed = await configAuthorizer(ctx, tenant)
      } catch (error) {
        ctx.logger?.error(
          { tenantId: tenant.id, seam: 'authorizer', authorizer: 'config', err: error },
          'authorizeTenantAccess threw; denying (fail-closed)'
        )
        // Fail-closed backstop tripped: a throw was converted to a deny. Emit the
        // isthmus guard (operator counter + best-effort event) so a swallowed-throw
        // regression is never invisible. Runs BEFORE the deny returns.
        emitIsthmusEvent('guard.plugin_authorizer', {
          tenantId: tenant.id,
          metadata: { authorizer: 'config' },
        })
        return { allow: false, reason: 'authorizeTenantAccess threw' }
      }
      if (!allowed) return { allow: false, reason: 'authorizeTenantAccess returned false' }
    }

    for (const entry of this.#ordered()) {
      let decision: AuthorizerDecision
      try {
        // Deadline-to-deny: wrap the untrusted authorizer so a hang denies rather
        // than blocking the request. No rateLimit option means no Redis dependency;
        // the signal is available but the (ctx, tenant) authorizer contract does
        // not thread it, so a non-cooperative authorizer keeps running past the
        // deadline (documented caveat) while the caller is unblocked with a deny.
        decision = await executeExtension(() => Promise.resolve(entry.authorize(ctx, tenant)), {
          label: `authorizer:${entry.name}`,
          timeoutMs: deadlineMs,
        })
      } catch (error) {
        const outcome = error instanceof ExtensionTimeoutError ? 'timeout' : 'threw'
        ctx.logger?.error(
          { tenantId: tenant.id, seam: 'authorizer', authorizer: entry.name, outcome, err: error },
          `authorizer "${entry.name}" ${outcome}; denying (fail-closed)`
        )
        emitIsthmusEvent('guard.plugin_authorizer', {
          tenantId: tenant.id,
          metadata: { authorizer: entry.name, outcome },
        })
        return { allow: false, reason: `authorizer "${entry.name}" ${outcome}` }
      }
      if (!decision.allow) return decision
    }

    return { allow: true }
  }

  /** Entries sorted by ascending `order` (default 0); Map preserves registration
   *  order, and Array#sort is stable, so equal `order` keeps registration order. */
  #ordered(): TenantAuthorizerEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }
}
