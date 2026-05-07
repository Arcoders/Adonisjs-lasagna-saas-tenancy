import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Context passed to every bootstrapper. `request` is absent in non-HTTP
 * call sites (queue jobs, scripts, scheduled tasks).
 */
export interface BootstrapperContext {
  tenant: TenantModelContract
  request?: HttpContext['request']
}

/**
 * A unit of per-tenant context activation. `enter` runs when the tenant
 * context becomes active; `leave` runs when it deactivates (LIFO with the
 * order bootstrappers were registered). `enter` errors propagate; `leave`
 * errors are logged but do not block other teardown.
 */
export interface TenantBootstrapper {
  readonly name: string
  enter(ctx: BootstrapperContext): void | Promise<void>
  leave?(ctx: BootstrapperContext): void | Promise<void>
}

export default class BootstrapperRegistry {
  readonly #items = new Map<string, TenantBootstrapper>()
  readonly #order: string[] = []

  register(bootstrapper: TenantBootstrapper): this {
    if (this.#items.has(bootstrapper.name)) {
      throw new Error(
        `BootstrapperRegistry: bootstrapper "${bootstrapper.name}" already registered`
      )
    }
    this.#items.set(bootstrapper.name, bootstrapper)
    this.#order.push(bootstrapper.name)
    return this
  }

  unregister(name: string): boolean {
    if (!this.#items.delete(name)) return false
    const idx = this.#order.indexOf(name)
    if (idx >= 0) this.#order.splice(idx, 1)
    return true
  }

  has(name: string): boolean {
    return this.#items.has(name)
  }

  list(): readonly string[] {
    return [...this.#order]
  }

  clear(): this {
    this.#items.clear()
    this.#order.length = 0
    return this
  }

  async runEnter(ctx: BootstrapperContext): Promise<void> {
    for (const name of this.#order) {
      const b = this.#items.get(name)
      if (!b) continue
      await b.enter(ctx)
    }
  }

  async runLeave(ctx: BootstrapperContext): Promise<void> {
    await this.#runLeaveUpTo(ctx, this.#order.length)
  }

  /**
   * Run `enter` then `fn` then `leave` atomically. Guarantees that every
   * bootstrapper whose `enter` succeeded gets its matching `leave`, even if
   * `fn` throws or a later `enter` fails.
   */
  async runScoped<T>(ctx: BootstrapperContext, fn: () => T | Promise<T>): Promise<T> {
    let completed = 0
    try {
      for (const name of this.#order) {
        const b = this.#items.get(name)
        if (!b) continue
        await b.enter(ctx)
        completed++
      }
      return await fn()
    } finally {
      await this.#runLeaveUpTo(ctx, completed)
    }
  }

  async #runLeaveUpTo(ctx: BootstrapperContext, count: number): Promise<void> {
    for (let i = Math.min(count, this.#order.length) - 1; i >= 0; i--) {
      const name = this.#order[i]
      const b = this.#items.get(name)
      if (!b?.leave) continue
      try {
        await b.leave(ctx)
      } catch (error) {
        await this.#logLeaveFailure(name, error)
      }
    }
  }

  async #logLeaveFailure(name: string, error: any): Promise<void> {
    try {
      const { default: logger } = await import('@adonisjs/core/services/logger')
      logger.error(
        { bootstrapper: name, error: error?.message },
        'bootstrapper leave failed; continuing teardown'
      )
    } catch {
      // logger unavailable (e.g. unit tests); fall back to stderr
      // eslint-disable-next-line no-console
      console.error(`[multitenancy] bootstrapper leave failed (${name}):`, error?.message)
    }
  }
}
