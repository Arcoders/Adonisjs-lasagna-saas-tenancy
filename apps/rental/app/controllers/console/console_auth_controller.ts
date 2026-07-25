import type { HttpContext } from '@adonisjs/core/http'
import { errors as authErrors } from '@adonisjs/auth'
import BackofficeUser from '#app/models/backoffice/backoffice_user'
import TenantUser from '#app/models/tenant_scoped/tenant_user'
import { loginValidator } from '#app/validators/auth_validator'
import { isAuthorizedStaff, WEB_TENANT_COMPANY_KEY } from '#app/security/session_realm'

/**
 * Session login for both browser consoles. The routes are `universal()`, so one
 * controller serves both realms and the resolved host decides which:
 *
 *   - apex `localhost`        → no tenant → operator realm (`web-backoffice`)
 *   - `<slug>.localhost`      → a tenant  → company realm (`web-tenant`)
 *
 * `verifyCredentials` for the tenant realm hits the resolved company's own
 * schema (through the tenant adapter), so an operator can never log into a
 * company console and vice-versa — the credential lookup lives in a different
 * schema entirely.
 */
export default class ConsoleAuthController {
  async show(ctx: HttpContext) {
    const tenant = await this.#tenantOrNull(ctx)
    if (tenant) {
      if (await isAuthorizedStaff(ctx, tenant)) return ctx.response.redirect('/')
      // `company` (incl. its name) rides in shared props (see InertiaMiddleware).
      return ctx.inertia.render('tenant/login', {})
    }
    if (await ctx.auth.use('web-backoffice').check()) return ctx.response.redirect('/')
    return ctx.inertia.render('operator/login', {})
  }

  async store(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    const tenant = await this.#tenantOrNull(ctx)

    try {
      if (tenant) {
        const user = await TenantUser.verifyCredentials(email, password)
        await ctx.auth.use('web-tenant').login(user)
        // Pin the session to the company it was issued for (see session_realm).
        ctx.session.put(WEB_TENANT_COMPANY_KEY, tenant.id)
      } else {
        const user = await BackofficeUser.verifyCredentials(email, password)
        await ctx.auth.use('web-backoffice').login(user)
      }
    } catch (error) {
      if (error instanceof authErrors.E_INVALID_CREDENTIALS) {
        ctx.session.flash('error', 'Those credentials do not match our records.')
        return ctx.response.redirect().back()
      }
      throw error
    }

    return ctx.response.redirect('/')
  }

  async destroy(ctx: HttpContext) {
    const tenant = await this.#tenantOrNull(ctx)
    await ctx.auth.use(tenant ? 'web-tenant' : 'web-backoffice').logout()
    return ctx.response.redirect('/login')
  }

  /**
   * The resolved company on this request, or null on the apex. `request.tenant()`
   * returns the value UniversalMiddleware already memoized on a company host, and
   * throws (no DB hit) on the apex — which we read as "operator realm".
   */
  async #tenantOrNull(ctx: HttpContext) {
    try {
      return await ctx.request.tenant()
    } catch {
      return null
    }
  }
}
