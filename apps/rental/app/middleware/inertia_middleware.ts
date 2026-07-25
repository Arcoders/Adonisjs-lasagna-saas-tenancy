import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import BaseInertiaMiddleware from '@adonisjs/inertia/inertia_middleware'
import { isAuthorizedStaff } from '#app/security/session_realm'

/**
 * Concrete Inertia middleware. The base class handles the Inertia request
 * protocol (init/dispose, version negotiation, redirect-status upgrades); we add
 * the `handle()` hook the router calls and the per-request `share()` payload that
 * every page receives as props.
 *
 * Shared props are deliberately thin: flash messages and validation errors (so a
 * failed login re-renders with its error), plus the signed-in identity for
 * whichever browser realm authenticated this request. The React layouts read
 * `auth` to decide which shell (operator vs company) to paint.
 */
export default class InertiaMiddleware extends BaseInertiaMiddleware {
  async share(ctx: HttpContext) {
    return {
      flash: (ctx.session?.flashMessages.all() ?? {}) as Record<string, any>,
      errors: this.getValidationErrors(ctx),
      auth: {
        operator: await this.#currentOperator(ctx),
        staff: await this.#currentStaff(ctx),
      },
      // The resolved company on a tenant host, so every company page + the sign-in
      // shell can name it without each controller threading it through. Null on
      // the apex (operator realm).
      company: await this.#currentCompany(ctx),
    }
  }

  async handle(ctx: HttpContext, next: NextFn) {
    await this.init(ctx)
    const output = await next()
    this.dispose(ctx)
    return output
  }

  /**
   * The operator behind a `web-backoffice` session, or null. `check()` is
   * side-effect free and returns false when no session cookie is present, so
   * this is safe to run on every request including anonymous ones.
   */
  async #currentOperator(ctx: HttpContext) {
    if (!(await ctx.auth.use('web-backoffice').check())) return null
    const user = ctx.auth.use('web-backoffice').user
    return user ? { id: user.id, email: user.email, fullName: user.fullName } : null
  }

  /**
   * The company staff member behind a `web-tenant` session, or null. Uses the
   * company-pinned check so shared props never surface a session that belongs to
   * a different company (or the apex, where no tenant resolves).
   */
  async #currentStaff(ctx: HttpContext) {
    let tenant
    try {
      tenant = await ctx.request.tenant()
    } catch {
      return null
    }
    if (!(await isAuthorizedStaff(ctx, tenant))) return null
    const user = ctx.auth.use('web-tenant').user
    return user
      ? { id: user.id, email: user.email, fullName: user.fullName, role: user.role }
      : null
  }

  /**
   * The resolved company for this request (id, name, plan), or null on the apex.
   * Rendered into shared props so company pages read `company` without a
   * per-controller prop.
   */
  async #currentCompany(ctx: HttpContext) {
    let tenant
    try {
      tenant = await ctx.request.tenant()
    } catch {
      return null
    }
    return {
      id: tenant.id,
      name: tenant.name,
      plan: String(tenant.metadata?.plan ?? 'starter'),
      tier: String(tenant.metadata?.tier ?? 'standard'),
      maintenance: Boolean(tenant.isMaintenance),
    }
  }
}
