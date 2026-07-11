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

// Provision a tenant synchronously (skips BullMQ). Mirrors
// InstallTenant.execute(); retries 3× to match the production
// dispatch's resilience under full-suite load. Returns 'failed'
// on permanent failure for negative-path tests to assert on.
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
      // Close before dropping. Otherwise the pool keeps sessions whose
      // search_path points at a just-dropped schema, surfacing as random
      // 503s several specs later.
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

// Creates the tenant row, provisions inline, and (by default) runs
// tenant:migrate so the schema has `notes` ready for write tests.
// The POST enqueues nothing because bootstrap.ts stubs the dispatch.
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
  const status = await installInline(id)
  if (status !== 'active') {
    throw new Error(
      `createInstalledTenant: install did not reach 'active' for ${id} (status="${status}")`
    )
  }
  if (opts.migrate !== false) {
    const code = await runAce('tenant:migrate', ['--tenant', id])
    if (code !== 0) throw new Error(`tenant:migrate exited ${code} for ${id}`)
  }
  return { id, status: 'active' }
}

// Drop schemas + delete rows for every registered tenant. Closes the Lucid
// connection FIRST: leaving it racing the package's LRU eviction against
// a just-dropped schema surfaced as ~3 random 503s per full-suite run.
export async function dropAllTenants(): Promise<void> {
  const all = await Tenant.query()
  for (const t of all) {
    await t.closeConnection().catch(() => {})
    await t.dropSchemaIfExists().catch(() => {})
    await t.delete()
  }
}

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
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${opts.description ? `: ${opts.description}` : ''}`
  )
}

export function getEmitter() {
  return emitter
}
