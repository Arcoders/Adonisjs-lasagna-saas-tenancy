import app from '@adonisjs/core/services/app'
import ImpersonationService from '../services/impersonation_service.js'
import ImpersonationInvalidException from '../exceptions/impersonation_invalid_exception.js'
import { getConfig } from '../config.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const DEFAULT_HEADER = 'x-impersonation-token'
const DEFAULT_COOKIE = '__impersonation'

/**
 * Verifies an impersonation token (header or cookie) and attaches the
 * derived context to `ctx.impersonation`. Invalid tokens throw 401 —
 * soft failure would let attackers probe with random tokens.
 */
export default class ImpersonationMiddleware {
  // Method seam (not constructor injection) because the named-middleware
  // factory resolves this class via the IoC container, and the container
  // can't inject ImpersonationService without a config-validated boot.
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
