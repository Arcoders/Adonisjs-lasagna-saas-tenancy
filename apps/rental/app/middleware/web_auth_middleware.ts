import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { isAuthorizedStaff } from '#app/security/session_realm'

/**
 * Gate for the browser console page shells. The pages live on `universal()`
 * routes (so the same paths resolve on both the apex and a company host), so
 * each page declares which realm it belongs to and this middleware enforces it:
 *
 *   - `realm: 'operator'` — must be the apex with a `web-backoffice` session.
 *     On a company host it bounces to `/` (that host's tenant home).
 *   - `realm: 'tenant'`  — must be a company host with a company-pinned
 *     `web-tenant` session. On the apex it bounces to `/` (the operator home).
 *
 * An unauthenticated visitor on the right host is sent to `/login`, which itself
 * renders the correct realm's sign-in. Data endpoints keep their own guards
 * (the admin satellite's auth, the tenant membership gate); this only guards the
 * shells so a page never renders for the wrong realm.
 */
export default class WebAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { realm: 'operator' | 'tenant' }) {
    const tenant = await this.#tenantOrNull(ctx)

    if (options.realm === 'tenant') {
      if (!tenant) return ctx.response.redirect('/')
      if (!(await isAuthorizedStaff(ctx, tenant))) return ctx.response.redirect('/login')
    } else {
      if (tenant) return ctx.response.redirect('/')
      if (!(await ctx.auth.use('web-backoffice').check())) return ctx.response.redirect('/login')
    }

    return next()
  }

  async #tenantOrNull(ctx: HttpContext) {
    try {
      return await ctx.request.tenant()
    } catch {
      return null
    }
  }
}
