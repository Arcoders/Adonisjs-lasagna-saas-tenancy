/** A backoffice-stored widget owned by a tenant. */
export interface Widget {
  id: string
  tenantId: string
  name: string
  enabled: boolean
}

/**
 * The satellite's service contract. Defining it as an interface is what lets the
 * in-memory test double (`InMemoryWidgetStore`) be a drop-in second
 * implementation — the "second implementation proves the abstraction" pattern.
 */
export interface WidgetStore {
  create(input: { tenantId: string; name: string }): Promise<Widget>
  get(id: string): Promise<Widget | null>
  listForTenant(tenantId: string): Promise<Widget[]>
  setEnabled(id: string, enabled: boolean): Promise<Widget | null>
  deleteForTenant(tenantId: string): Promise<number>
}
