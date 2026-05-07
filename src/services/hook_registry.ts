import type { TenantModelContract } from '../types/contracts.js'
import type { BackupMetadata } from './backup_service.js'
import type { CloneResult } from './clone_service.js'

export type TenantLifecyclePhase = 'before' | 'after'

export type TenantLifecycleEvent =
  | 'provision'
  | 'destroy'
  | 'backup'
  | 'restore'
  | 'clone'
  | 'migrate'

export type TenantLifecycleHook<C = TenantHookContext> = (ctx: C) => void | Promise<void>

export interface TenantHookContext {
  tenant: TenantModelContract
}

export interface TenantBackupHookContext extends TenantHookContext {
  metadata?: BackupMetadata
}

export interface TenantRestoreHookContext extends TenantHookContext {
  fileName: string
}

export interface TenantCloneHookContext {
  source: TenantModelContract
  destination: TenantModelContract
  result?: CloneResult
}

export interface TenantMigrateHookContext extends TenantHookContext {
  direction: 'up' | 'down'
}

export interface HookContextByEvent {
  provision: TenantHookContext
  destroy: TenantHookContext
  backup: TenantBackupHookContext
  restore: TenantRestoreHookContext
  clone: TenantCloneHookContext
  migrate: TenantMigrateHookContext
}

export interface DeclarativeHooks {
  beforeProvision?: TenantLifecycleHook<TenantHookContext>
  afterProvision?: TenantLifecycleHook<TenantHookContext>
  beforeDestroy?: TenantLifecycleHook<TenantHookContext>
  afterDestroy?: TenantLifecycleHook<TenantHookContext>
  beforeBackup?: TenantLifecycleHook<TenantBackupHookContext>
  afterBackup?: TenantLifecycleHook<TenantBackupHookContext>
  beforeRestore?: TenantLifecycleHook<TenantRestoreHookContext>
  afterRestore?: TenantLifecycleHook<TenantRestoreHookContext>
  beforeClone?: TenantLifecycleHook<TenantCloneHookContext>
  afterClone?: TenantLifecycleHook<TenantCloneHookContext>
  beforeMigrate?: TenantLifecycleHook<TenantMigrateHookContext>
  afterMigrate?: TenantLifecycleHook<TenantMigrateHookContext>
}

type HookKey = `${TenantLifecyclePhase}:${TenantLifecycleEvent}`

const PHASE_EVENTS: Array<[TenantLifecyclePhase, TenantLifecycleEvent]> = [
  ['before', 'provision'],
  ['after', 'provision'],
  ['before', 'destroy'],
  ['after', 'destroy'],
  ['before', 'backup'],
  ['after', 'backup'],
  ['before', 'restore'],
  ['after', 'restore'],
  ['before', 'clone'],
  ['after', 'clone'],
  ['before', 'migrate'],
  ['after', 'migrate'],
]

function declarativeKey(phase: TenantLifecyclePhase, event: TenantLifecycleEvent): keyof DeclarativeHooks {
  const cap = event[0].toUpperCase() + event.slice(1)
  return `${phase}${cap}` as keyof DeclarativeHooks
}

export default class HookRegistry {
  readonly #hooks = new Map<HookKey, TenantLifecycleHook<any>[]>()

  before<E extends TenantLifecycleEvent>(
    event: E,
    hook: TenantLifecycleHook<HookContextByEvent[E]>
  ): this {
    return this.#register('before', event, hook)
  }

  after<E extends TenantLifecycleEvent>(
    event: E,
    hook: TenantLifecycleHook<HookContextByEvent[E]>
  ): this {
    return this.#register('after', event, hook)
  }

  loadDeclarative(hooks: DeclarativeHooks | undefined): this {
    if (!hooks) return this
    for (const [phase, event] of PHASE_EVENTS) {
      const hook = hooks[declarativeKey(phase, event)]
      if (hook) this.#register(phase, event, hook as TenantLifecycleHook<any>)
    }
    return this
  }

  async run<E extends TenantLifecycleEvent>(
    phase: TenantLifecyclePhase,
    event: E,
    ctx: HookContextByEvent[E]
  ): Promise<void> {
    const hooks = this.#hooks.get(`${phase}:${event}`)
    if (!hooks || hooks.length === 0) return

    for (const hook of hooks) {
      try {
        await hook(ctx)
      } catch (error) {
        if (phase === 'before') throw error
        await this.#logAfterFailure(phase, event, error)
      }
    }
  }

  async #logAfterFailure(
    phase: TenantLifecyclePhase,
    event: TenantLifecycleEvent,
    error: any
  ): Promise<void> {
    try {
      const { default: logger } = await import('@adonisjs/core/services/logger')
      logger.error({ phase, event, error: error?.message }, 'after-hook failed; continuing')
    } catch {
      // logger unavailable (e.g. unit tests without booted app); fall back to stderr
      // eslint-disable-next-line no-console
      console.error(`[multitenancy] after-hook failed (${phase}:${event}):`, error?.message)
    }
  }

  clear(): this {
    this.#hooks.clear()
    return this
  }

  #register(
    phase: TenantLifecyclePhase,
    event: TenantLifecycleEvent,
    hook: TenantLifecycleHook<any>
  ): this {
    const key: HookKey = `${phase}:${event}`
    const existing = this.#hooks.get(key)
    if (existing) existing.push(hook)
    else this.#hooks.set(key, [hook])
    return this
  }
}
