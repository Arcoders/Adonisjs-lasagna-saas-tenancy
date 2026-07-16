import { randomUUID } from 'node:crypto'
import ExampleWidget from './example_widget.js'
import type { Widget, WidgetStore } from './types.js'

/**
 * The production implementation of `WidgetStore`, backed by the Lucid model. The
 * provider registers it as a container singleton; controllers/commands resolve
 * it with `app.container.make(ExampleWidgetService)`.
 */
export default class ExampleWidgetService implements WidgetStore {
  async create(input: { tenantId: string; name: string }): Promise<Widget> {
    const row = await ExampleWidget.create({
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      enabled: true,
    })
    return toWidget(row)
  }

  async get(id: string): Promise<Widget | null> {
    const row = await ExampleWidget.find(id)
    return row ? toWidget(row) : null
  }

  async listForTenant(tenantId: string): Promise<Widget[]> {
    const rows = await ExampleWidget.query().where('tenant_id', tenantId)
    return rows.map(toWidget)
  }

  async setEnabled(id: string, enabled: boolean): Promise<Widget | null> {
    const row = await ExampleWidget.find(id)
    if (!row) return null
    row.enabled = enabled
    await row.save()
    return toWidget(row)
  }

  async deleteForTenant(tenantId: string): Promise<number> {
    const result: unknown = await ExampleWidget.query().where('tenant_id', tenantId).delete()
    if (Array.isArray(result)) return Number(result[0] ?? 0)
    return Number(result ?? 0)
  }
}

function toWidget(row: ExampleWidget): Widget {
  return { id: row.id, tenantId: row.tenantId, name: row.name, enabled: row.enabled }
}
