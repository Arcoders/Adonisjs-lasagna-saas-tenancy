import type { HttpContext } from '@adonisjs/core/http'
import { executeExtension } from '@adonisjs-lasagna/saas-tenancy/services'
import { adminActionRegistry, isSafeActionName } from '../admin_action_registry.js'
import { ADMIN_CONTRACT_VERSION } from '../constants.js'

export interface AdminActionsControllerOptions {
  /** Optional execution guards for host actions; off by default. */
  timeoutMs?: number
  rateLimit?: { limit: number; windowSeconds: number }
}

/**
 * Dispatches host-registered {@link AdminAction}s. Mounted behind the admin auth
 * middleware (the whole admin group is fail-closed). An unknown or unsafe
 * `:name` is a 404 — never a registry lookup on untrusted input.
 */
export default class AdminActionsController {
  constructor(private options: AdminActionsControllerOptions = {}) {}

  async dispatch(ctx: HttpContext) {
    const name = ctx.params.name
    if (!isSafeActionName(name)) {
      return ctx.response.notFound({ error: `unknown admin action "${name}"` })
    }
    const action = adminActionRegistry.get(name)
    if (!action) {
      return ctx.response.notFound({ error: `unknown admin action "${name}"` })
    }

    const ip = typeof ctx.request.ip === 'function' ? ctx.request.ip() : undefined
    const result = await executeExtension(
      (signal) => Promise.resolve(action.execute(ctx, signal)),
      {
        label: `admin:${name}`,
        timeoutMs: this.options.timeoutMs,
        rateLimit: this.options.rateLimit,
        rateLimitKey: `ext:admin:${name}${ip ? `:${ip}` : ''}`,
      }
    )
    return ctx.response.ok({ data: result })
  }

  /** List the names of every registered admin action. */
  async list(ctx: HttpContext) {
    return ctx.response.ok({ data: adminActionRegistry.list() })
  }

  /** Report the admin-action contract version this build implements. */
  async contractVersion(ctx: HttpContext) {
    return ctx.response.ok({ version: ADMIN_CONTRACT_VERSION })
  }
}
