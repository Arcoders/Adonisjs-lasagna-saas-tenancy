import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ace from '@adonisjs/core/services/ace'
import emitter from '@adonisjs/core/services/emitter'
import {
  TenantCreated,
  TenantActivated,
  TenantProvisioned,
} from '@adonisjs-lasagna/saas-tenancy/events'
import Tenant from '#app/models/backoffice/tenant'

const execFileP = promisify(execFile)

export const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN ?? 'demo-admin-token-change-me'
export const ADMIN_HEADERS = { 'x-admin-token': ADMIN_TOKEN }

export async function runAce(command: string, args: string[] = []): Promise<number> {
  const cmd = await ace.exec(command, args)
  return cmd.exitCode ?? 0
}

export async function probePgTool(name: 'pg_dump' | 'pg_restore' | 'psql'): Promise<boolean> {
  try {
    await execFileP(name, ['--version'])
    return true
  } catch {
    return false
  }
}

export async function probePgTools(): Promise<boolean> {
  const [a, b, c] = await Promise.all([
    probePgTool('pg_dump'),
    probePgTool('pg_restore'),
    probePgTool('psql'),
  ])
  return a && b && c
}

/**
 * Synchronously provision a tenant — bypasses the BullMQ queue so the suite
 * doesn't need a worker subprocess. Mirrors what InstallTenant.execute() does:
 * runs the beforeProvision hook, calls tenant.install(), emits the lifecycle
 * events.
 *
 * The dispatched events: TenantCreated, TenantProvisioned, TenantActivated —
 * matching the production `InstallTenant` job's emissions.
 */
export async function installInline(id: string): Promise<'active' | 'failed'> {
  const tenant = await Tenant.findOrFail(id)
  try {
    const cfgHooks: any = (await import('#config/multitenancy')).default.hooks
    if (cfgHooks?.beforeProvision) {
      await cfgHooks.beforeProvision({ tenant })
    }
    await tenant.install()
    await TenantCreated.dispatch(tenant as any)
    await TenantProvisioned.dispatch(tenant as any)
    await TenantActivated.dispatch(tenant as any)
    return 'active'
  } catch {
    tenant.status = 'failed'
    await tenant.save()
    return 'failed'
  }
}

export interface CreateInstalledTenantOptions {
  name?: string
  email?: string
  plan?: 'free' | 'pro'
  tier?: 'standard' | 'premium'
  /** Run `tenant:migrate` after install (default: true). Set false for negative tests. */
  migrate?: boolean
}

/**
 * One-shot helper: creates the tenant row, runs the inline install, and (by
 * default) runs `tenant:migrate` so the schema has the `notes` table ready
 * for write tests.
 */
export async function createInstalledTenant(
  client: any,
  opts: CreateInstalledTenantOptions = {}
): Promise<{ id: string; status: 'active' | 'failed' }> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const r = await client.post('/demo/tenants').json({
    name: opts.name ?? `E2E-${stamp}`,
    email: opts.email ?? `${stamp}@e2e.test`,
    plan: opts.plan ?? 'pro',
    tier: opts.tier ?? 'premium',
  })
  if (r.status() !== 202) {
    throw new Error(`Failed to create tenant: ${r.status()} ${JSON.stringify(r.body())}`)
  }
  const id = r.body().tenantId as string
  const status = await installInline(id)
  if (status === 'active' && opts.migrate !== false) {
    const code = await runAce('tenant:migrate', ['--tenant', id])
    if (code !== 0) throw new Error(`tenant:migrate exited ${code} for ${id}`)
  }
  return { id, status }
}

/**
 * Drop schemas + delete rows for every tenant currently in the backoffice
 * registry. Used by `group.setup`/`group.teardown` to keep suites rerunnable.
 */
export async function dropAllTenants(): Promise<void> {
  const all = await Tenant.query()
  for (const t of all) {
    try {
      await t.dropSchemaIfExists()
    } catch {
      // Schema may already be gone (e.g. soft-delete + purge ran in a prior test).
    }
    await t.delete()
  }
}

/**
 * Wait for a predicate to become truthy, polling at the given interval.
 * Throws after `timeoutMs` if the predicate never returned truthy.
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const intervalMs = opts.intervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v as T
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${opts.description ? `: ${opts.description}` : ''}`)
}

/**
 * Detach all current listeners for a given event class. Restoration must be
 * arranged manually — call `emitter.on(EventClass, handler)` again after the
 * test, or rely on `group.teardown` + a fresh `setup`.
 *
 * Used by the lifecycle and contextual-logging tests when they need to swap
 * listeners temporarily.
 */
export function getEmitter() {
  return emitter
}
