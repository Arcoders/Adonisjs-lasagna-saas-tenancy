import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import NotesService from '#app/services/notes_service'
import { createNoteValidator } from '#app/validators/notes_validator'
import type { DemoMeta } from '#app/models/backoffice/tenant'

/**
 * Demonstrates schema isolation, generic `TenantModelContract<DemoMeta>`,
 * contextual logging (via NotesService → tenantLogger), and quota
 * enforcement (the route is wrapped in `enforceQuota('apiCallsPerDay')` —
 * see start/routes.ts).
 */
@inject()
export default class NotesController {
  constructor(private readonly notes: NotesService) {}

  async list({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const rows = await this.notes.list(tenant)
    return response.ok({ tenantId: tenant.id, plan: tenant.metadata?.plan, notes: rows })
  }

  async listFromReplica({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    return response.ok(await this.notes.listFromReplica(tenant))
  }

  async create({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const payload = await request.validateUsing(createNoteValidator)
    const note = await this.notes.create(tenant, payload)
    return response.created({ tenantId: tenant.id, note })
  }
}
