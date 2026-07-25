import type { HttpContext } from '@adonisjs/core/http'
import { randomUUID } from 'node:crypto'
import FleetDoc from '#app/models/tenant_scoped/fleet_doc'

/**
 * Policy/FAQ documents that feed the fleet assistant. Creating one stores the
 * domain row; the body is ingested into the per-tenant vector store separately
 * through `POST /ai/embed` (source = the doc's `source` key), so the AI
 * satellite owns the embedding lifecycle.
 */
export default class FleetDocsController {
  async list({ response }: HttpContext) {
    return response.ok({ docs: await FleetDoc.query().orderBy('created_at', 'desc') })
  }

  async create({ request, response }: HttpContext) {
    const title = String(request.input('title') ?? '').slice(0, 200)
    const body = String(request.input('body') ?? '').slice(0, 8000)
    const source = String(request.input('source') ?? `doc-${randomUUID().slice(0, 8)}`)
    const existing = await FleetDoc.query().where('source', source).first()
    if (existing) {
      existing.title = title
      existing.body = body
      await existing.save()
      return response.ok({ doc: existing })
    }
    const doc = await FleetDoc.create({ id: randomUUID(), title, body, source })
    return response.created({ doc })
  }
}
