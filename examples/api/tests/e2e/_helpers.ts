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
 * Retries up to 3× with backoff to absorb transient PG/Redis hiccups under
 * full-suite load (production goes through `InstallTenant.dispatch`, which
 * BullMQ retries; the inline path needs equivalent resilience or tests
 * cascade into 503s on unrelated specs). Returns 'active' on success or
 * 'failed' on permanent failure — the latter is preserved so failure-path
 * tests (e.g. "beforeProvision rejects bad email") can assert on it. The
 * happy-path helper `createInstalledTenant` upgrades 'failed' to an explicit
 * throw so silent install failures don't cascade into mysterious 503s later.
 */
export async function installInline(id: string): Promise<'active' | 'failed'> {
  const tenant = await Tenant.findOrFail(id)
  const cfgHooks: any = (await import('#config/multitenancy')).default.hooks

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (cfgHooks?.beforeProvision) {
        await cfgHooks.beforeProvision({ tenant })
      }
      await tenant.install()
      await TenantCreated.dispatch(tenant as any)
      await TenantProvisioned.dispatch(tenant as any)
      await TenantActivated.dispatch(tenant as any)
      return 'active'
    } catch {
      // Schema may have been partially created — close any Lucid connection
      // that points at it AND drop before retrying. Without the close, the
      // next `CREATE SCHEMA IF NOT EXISTS` succeeds but the pool still has
      // pre-existing sessions whose `search_path` points at the just-dropped
      // schema, which surfaces as random 503s several specs later under
      // full-suite load (zombie pool entries in `db.manager`).
      await tenant.closeConnection().catch(() => {})
      await tenant.dropSchemaIfExists().catch(() => {})
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 100 * attempt))
      }
    }
  }
  tenant.status = 'failed'
  await tenant.save().catch(() => {})
  return 'failed'
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
): Promise<{ id: string; status: 'active' }> {
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
  // Upgrade a silent 'failed' to a loud throw — the happy-path helper exists
  // exactly so unrelated specs don't have to debug random 503s caused by a
  // tenant that failed to install several tests ago.
  const status = await installInline(id)
  if (status !== 'active') {
    throw new Error(
      `createInstalledTenant: install did not reach 'active' for ${id} (status="${status}"). ` +
        `Inspect logs for the underlying error; common causes: PG connection saturation, hook rejection.`
    )
  }
  if (opts.migrate !== false) {
    const code = await runAce('tenant:migrate', ['--tenant', id])
    if (code !== 0) throw new Error(`tenant:migrate exited ${code} for ${id}`)
  }
  return { id, status: 'active' }
}

/**
 * Drop schemas + delete rows for every tenant currently in the backoffice
 * registry. Used by `group.setup`/`group.teardown` to keep suites rerunnable.
 *
 * Closes the Lucid connection registered for each tenant FIRST. Skipping that
 * leaves a `tenant_<uuid>` entry in `db.manager` whose pool keeps sessions
 * with `search_path` pointing at a schema that gets dropped a moment later;
 * a subsequent `db.manager.release(oldest)` triggered by the package's LRU
 * eviction (`SchemaPgDriver.#lru` cap of 50) under full-suite load fires
 * fire-and-forget — racing with whatever query is currently in flight on
 * that connection. Empirically that race surfaced as ~3 random 503s on
 * tenant-scoped routes per full-suite run, with a varying mix of failing
 * specs — never reproducible in isolation. Closing here keeps both LRUs
 * (the package's and this model's) bounded by the live tenant set.
 */
export async function dropAllTenants(): Promise<void> {
  const all = await Tenant.query()
  for (const t of all) {
    await t.closeConnection().catch(() => {})
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
