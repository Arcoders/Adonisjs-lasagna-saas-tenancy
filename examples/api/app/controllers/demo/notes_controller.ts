import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import NotesService from '#app/services/notes_service'
import { createNoteValidator } from '#app/validators/notes_validator'
import { currentTenant } from '#app/helpers/current_tenant'

/**
 * Demonstrates schema isolation, contextual logging (NotesService logs through
 * tenantLogger), and quota enforcement (the route is wrapped in
 * `enforceQuota('apiCallsPerDay')`, see start/routes.ts). Tenant narrowing
 * happens once in `currentTenant()`; for the generic
 * `request.tenant<DemoMeta>()` style see billing_controller.ts.
 */
@inject()
export default class NotesController {
  constructor(private readonly notes: NotesService) {}

  async list({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const rows = await this.notes.list(tenant)
    return response.ok({ tenantId: tenant.id, plan: tenant.metadata?.plan, notes: rows })
  }

  async listFromReplica({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    return response.ok(await this.notes.listFromReplica(tenant))
  }

  async create({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const payload = await request.validateUsing(createNoteValidator)
    const note = await this.notes.create(tenant, payload)
    return response.created({ tenantId: tenant.id, note })
  }
}
