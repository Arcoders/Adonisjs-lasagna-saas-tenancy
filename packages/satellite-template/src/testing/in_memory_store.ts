/**
 * A tiny, id-keyed in-memory collection for building hermetic test doubles.
 *
 * This is a self-contained helper you can copy into your own satellite. It has
 * zero dependencies and no coupling to Lasagna or AdonisJS. It backs the
 * `InMemoryWidgetStore` test double in this template; see the "Creating a
 * satellite" guide for the pattern.
 */
export default class InMemoryStore<T extends { id: string }> {
  readonly #records = new Map<string, T>()
  #counter = 0

  insert(record: T): T {
    if (this.#records.has(record.id)) {
      throw new Error(`InMemoryStore: duplicate id "${record.id}"`)
    }
    this.#records.set(record.id, { ...record })
    return { ...record }
  }

  get(id: string): T | null {
    const found = this.#records.get(id)
    return found ? { ...found } : null
  }

  filter(predicate: (record: T) => boolean): T[] {
    return [...this.#records.values()].filter(predicate).map((r) => ({ ...r }))
  }

  update(id: string, patch: Partial<Omit<T, 'id'>>): T | null {
    const existing = this.#records.get(id)
    if (!existing) return null
    const updated = { ...existing, ...patch, id } as T
    this.#records.set(id, updated)
    return { ...updated }
  }

  delete(id: string): boolean {
    return this.#records.delete(id)
  }

  /** A deterministic, monotonically increasing id (`<prefix>1`, `<prefix>2`, …). */
  seq(prefix = ''): string {
    return `${prefix}${++this.#counter}`
  }
}
