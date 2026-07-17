import type { HttpContext } from '@adonisjs/core/http'
import { isAuthorizedStaff } from '#app/security/session_realm'

/**
 * The console home (`GET /`). Like the auth controller it is host-aware: the
 * apex renders the operator dashboard, a company host renders that company's
 * staff dashboard. Anonymous visitors are bounced to `/login` (the same
 * universal login, which itself renders the right realm).
 *
 * The pages are thin shells: they hydrate their data client-side from the REST
 * surfaces that already exist and enforce their own auth — the operator console
 * calls the admin satellite under `/admin`, the company console calls the
 * tenant-guarded domain API. This keeps the browser consoles a 1:1 view over the
 * same endpoints the programmatic API and e2e suite drive.
 */
export default class ConsoleHomeController {
  async index(ctx: HttpContext) {
    const tenant = await this.#tenantOrNull(ctx)

    if (tenant) {
      if (!(await isAuthorizedStaff(ctx, tenant))) return ctx.response.redirect('/login')
      // `company` rides in shared props (see InertiaMiddleware); nothing to pass.
      return ctx.inertia.render('tenant/dashboard', {})
    }

    if (!(await ctx.auth.use('web-backoffice').check())) return ctx.response.redirect('/login')
    return ctx.inertia.render('operator/dashboard', {})
  }

  async #tenantOrNull(ctx: HttpContext) {
    try {
      return await ctx.request.tenant()
    } catch {
      return null
    }
  }
}
