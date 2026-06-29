import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Shape of the per-tenant context stored in AsyncLocalStorage by TenantLogContext.
 * It carries the required tenantId string plus an open-ended index signature for
 * arbitrary additional log bindings, and these fields become the child logger
 * bindings that any code running inside a run() scope will observe.
 */
export interface TenantLogContextData {
  tenantId: string
  [key: string]: unknown
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike
  trace(...args: any[]): void
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  fatal(...args: any[]): void
}

/**
 * Propagates per-tenant logging context across async boundaries using an
 * AsyncLocalStorage store. It runs a function with tenant bindings in scope,
 * exposes the active context and tenant id, and wraps a base logger so log
 * lines emitted anywhere within the scope inherit those bindings automatically.
 */
export default class TenantLogContext {
  readonly #als = new AsyncLocalStorage<TenantLogContextData>()

  /**
   * Execute `fn` with the given tenant context bound to AsyncLocalStorage.
   * Any code that reads {@link current} or calls {@link getLogger} from
   * inside `fn` (including async continuations) will see the bindings.
   */
  run<T>(context: TenantLogContextData, fn: () => T): T {
    return this.#als.run(context, fn)
  }

  /**
   * The active context, if any. Returns `undefined` outside a `run()` scope.
   */
  current(): TenantLogContextData | undefined {
    return this.#als.getStore()
  }

  /**
   * Returns the active tenantId or `undefined` outside a `run()` scope.
   */
  currentTenantId(): string | undefined {
    return this.#als.getStore()?.tenantId
  }

  /**
   * Wraps a base logger with the active context bindings (or returns the
   * logger unchanged if no context is active).
   */
  bind<L extends LoggerLike>(logger: L): L {
    const ctx = this.#als.getStore()
    if (!ctx) return logger
    return logger.child(ctx) as L
  }
}
