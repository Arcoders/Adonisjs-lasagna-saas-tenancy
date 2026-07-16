import InMemoryStore from './in_memory_store.js'
import type { Widget, WidgetStore } from '../types.js'

/**
 * In-memory `WidgetStore` for tests, the "second implementation that proves the
 * abstraction". It runs with no database, so a satellite author can unit-test
 * the service contract, controllers, and listeners hermetically. Built on the
 * small, copyable `InMemoryStore<T>` helper shipped in this template
 * (`src/testing/in_memory_store.ts`).
 */
export default class InMemoryWidgetStore implements WidgetStore {
  readonly #store = new InMemoryStore<Widget>()

  async create(input: { tenantId: string; name: string }): Promise<Widget> {
    return this.#store.insert({
      id: this.#store.seq('w_'),
      tenantId: input.tenantId,
      name: input.name,
      enabled: true,
    })
  }

  async get(id: string): Promise<Widget | null> {
    return this.#store.get(id)
  }

  async listForTenant(tenantId: string): Promise<Widget[]> {
    return this.#store.filter((w) => w.tenantId === tenantId)
  }

  async setEnabled(id: string, enabled: boolean): Promise<Widget | null> {
    return this.#store.update(id, { enabled })
  }

  async deleteForTenant(tenantId: string): Promise<number> {
    const victims = this.#store.filter((w) => w.tenantId === tenantId)
    for (const victim of victims) this.#store.delete(victim.id)
    return victims.length
  }
}
