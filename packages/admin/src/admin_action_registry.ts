import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { HttpContext } from '@adonisjs/core/http'
import { ADMIN_CONTRACT_VERSION } from './constants.js'

/** Action names go in the URL (`/actions/:name`), so they must be URL-safe. */
const SAFE_ACTION_NAME = /^[a-zA-Z0-9_-]{1,63}$/
export function isSafeActionName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_ACTION_NAME.test(name)
}

/**
 * A host-registered custom admin operation, dispatched at
 * `POST {adminPrefix}/actions/:name` behind the admin auth middleware. `execute`
 * receives the full {@link HttpContext} (read params/body, write the response or
 * return a value) and an optional `AbortSignal` that fires if a `timeoutMs` is
 * configured. Thread it into slow work so a deadline can unwind it.
 */
export interface AdminAction {
  readonly name: string
  readonly description: string
  /** Contract version this action was built against (see {@link ADMIN_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  execute(ctx: HttpContext, signal?: AbortSignal): Promise<unknown> | unknown
}

/**
 * Registry of host admin actions. Validated at registration time: an unsafe or
 * duplicate name throws, and `contractVersion` is checked via
 * `assertContractCompat` (a version newer than this build throws; older or absent warns).
 *
 * Admin ships no provider (it is routes + controllers over the core container),
 * so this is a MODULE-LEVEL singleton ({@link adminActionRegistry}) rather than
 * a container binding: the host registers on the same instance the dispatch
 * route reads.
 */
export class AdminActionRegistry {
  readonly #actions = new Map<string, AdminAction>()

  /** The admin-action contract version this surface implements. */
  get contractVersion(): number {
    return ADMIN_CONTRACT_VERSION
  }

  register(action: AdminAction): this {
    if (!isSafeActionName(action.name)) {
      throw new Error(
        `AdminActionRegistry: action name ${JSON.stringify(action.name)} is invalid — ` +
          'must match /^[a-zA-Z0-9_-]{1,63}$/.'
      )
    }
    if (this.#actions.has(action.name)) {
      throw new Error(
        `AdminActionRegistry: an action named "${action.name}" is already registered.`
      )
    }
    assertContractCompat(
      action.contractVersion,
      ADMIN_CONTRACT_VERSION,
      `admin action "${action.name}"`
    )
    this.#actions.set(action.name, action)
    return this
  }

  get(name: string): AdminAction | undefined {
    return this.#actions.get(name)
  }

  has(name: string): boolean {
    return this.#actions.has(name)
  }

  list(): readonly string[] {
    return [...this.#actions.keys()]
  }

  clear(): this {
    this.#actions.clear()
    return this
  }
}

/**
 * The process-wide admin-action registry. Import it from
 * `@adonisjs-lasagna/admin` and register actions in your app's `boot()`:
 *
 * @example
 *   import { adminActionRegistry, ADMIN_CONTRACT_VERSION } from '@adonisjs-lasagna/admin'
 *   adminActionRegistry.register({
 *     name: 'reindex_search',
 *     description: 'Rebuild the tenant search index',
 *     contractVersion: ADMIN_CONTRACT_VERSION,
 *     execute: async (ctx) => ({ queued: true }),
 *   })
 */
export const adminActionRegistry = new AdminActionRegistry()
