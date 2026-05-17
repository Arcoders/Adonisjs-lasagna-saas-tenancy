import app from '@adonisjs/core/services/app'
import ImpersonationService from '../services/impersonation_service.js'
import ImpersonationInvalidException from '../exceptions/impersonation_invalid_exception.js'
import { getConfig } from '../config.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const DEFAULT_HEADER = 'x-impersonation-token'
const DEFAULT_COOKIE = '__impersonation'

/**
 * Reads an impersonation token from a header (preferred) or cookie, verifies
 * it via `ImpersonationService.verify()`, and on success attaches the
 * derived context to `ctx.impersonation`. Hand the auth wiring to your
 * existing `auth.use()` middleware — this middleware deliberately does NOT
 * mutate `ctx.auth`.
 *
 * Behaviour modes:
 * - No token presented: pass through (`next()`).
 * - Token presented and valid: attach context, pass through.
 * - Token presented and INVALID: throw `ImpersonationInvalidException` (401).
 *   Soft failure would let attackers probe with random tokens; the loud
 *   failure also tells legitimate operators their session has expired.
 */
export default class ImpersonationMiddleware {
  /**
   * Override hook for tests — lets a spec swap in a fake
   * `ImpersonationService` without going through the container.
   *
   * Why this pattern and not a constructor param: AdonisJS's
   * named-middleware factory resolves the class through the IoC
   * container. A typed constructor parameter (even optional) makes
   * the container try to inject `ImpersonationService`, which it
   * can't because the service expects a config-validated boot.
   * Lifting the lookup into a method keeps the public surface
   * container-friendly while still leaving an override seam for
   * unit tests.
   */
  protected getService(): Promise<ImpersonationService> {
    return app.container.make(ImpersonationService)
  }

  async handle(ctx: HttpContext, next: NextFn) {
    const cfg = getConfig().impersonation
    const headerName = cfg?.headerName ?? DEFAULT_HEADER
    const cookieName = cfg?.cookieName ?? DEFAULT_COOKIE

    const fromHeader = ctx.request.header(headerName)
    const fromCookie = (ctx.request as any).cookie?.(cookieName)
    const token = (fromHeader ?? fromCookie) as string | null | undefined

    if (!token) return next()

    const svc = await this.getService()
    const verified = await svc.verify(token)
    if (!verified) throw new ImpersonationInvalidException()

    ctx.impersonation = verified
    return next()
  }
}
