import { createHash } from 'node:crypto'
import type { ApplicationService } from '@adonisjs/core/types'
// Deep-import the registry by exact file (not the `/services` barrel): the
// barrel re-exports tenant_logger, which top-level-awaits app.booted and throws
// when this module is first imported before the Ignitor has created the app.
import IsolationDriverRegistry from '../../../packages/core/build/src/services/isolation/registry.js'
import type { IsolationDriver } from '../../../packages/core/build/src/services/isolation/driver.js'

/**
 * Direct provisioning for the bench. Bypasses the async InstallTenant job so
 * seeding thousands of tenants is fast and deterministic: insert the backoffice
 * tenant row, then `driver.provision()` + `driver.migrate()` (for schema-pg /
 * database-pg; both no-op for rowscope-pg, whose shared table is migrated
 * centrally once).
 *
 * Tenant ids are deterministic per index, so re-running with the same count
 * reuses the same schemas/databases instead of accumulating orphans across runs.
 */

type DbService = any
type TenantRef = { id: string; name: string }

/** A valid UUID v4 derived deterministically from an index. */
export function deterministicTenantId(index: number): string {
  const h = createHash('sha256').update(`lasagna-bench-tenant-${index}`).digest('hex')
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
    `${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
  )
}

export function tenantRef(id: string): TenantRef {
  return { id, name: `bench-${id.slice(0, 8)}` }
}

export function tenantRefs(count: number): TenantRef[] {
  return Array.from({ length: count }, (_, i) => tenantRef(deterministicTenantId(i)))
}

export async function activeDriver(app: ApplicationService): Promise<IsolationDriver> {
  const registry = await app.container.make(IsolationDriverRegistry)
  return registry.active()
}

export async function pgVersion(db: DbService): Promise<string | null> {
  try {
    const res = await db.rawQuery('SELECT version()')
    const rows = Array.isArray(res.rows) ? res.rows : res
    return rows?.[0]?.version ?? null
  } catch {
    return null
  }
}

/** Create the backoffice schema + the minimal tenants registry table. Idempotent. */
export async function ensureBackofficeSchema(db: DbService): Promise<void> {
  await db.rawQuery('CREATE SCHEMA IF NOT EXISTS backoffice')
  await db.rawQuery('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await db.rawQuery(`
    CREATE TABLE IF NOT EXISTS backoffice.tenants (
      id            uuid PRIMARY KEY,
      name          varchar(255) NOT NULL,
      email         varchar(255) NOT NULL,
      status        varchar(255) NOT NULL,
      custom_domain varchar(255),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      deleted_at    timestamptz
    )
  `)
}

/** Run the central rowscope `notes` migration against the public connection. Idempotent. */
export async function ensureRowScopeTable(app: ApplicationService, db: DbService): Promise<void> {
  const { MigrationRunner } = await import('@adonisjs/lucid/migration')
  const runner = new MigrationRunner(db, app, { direction: 'up', connectionName: 'public' })
  await runner.run()
  if (runner.error) throw runner.error
}

async function insertTenantRow(db: DbService, ref: TenantRef): Promise<void> {
  await db.rawQuery(
    `INSERT INTO backoffice.tenants (id, name, email, status)
     VALUES (?, ?, ?, 'active')
     ON CONFLICT (id) DO UPDATE SET status = 'active', deleted_at = NULL`,
    [ref.id, ref.name, `${ref.name}@bench.test`]
  )
}

export interface SeedResult {
  driver: string
  ids: string[]
  refs: TenantRef[]
}

/**
 * Provision `count` tenants for the active driver. Returns their ids/refs.
 * Does NOT seed rows (call seedNotes for that) — separated so the churn /
 * budget tiers can provision without paying the seed cost when they don't
 * need rows.
 */
export async function provisionTenants(
  app: ApplicationService,
  db: DbService,
  count: number
): Promise<SeedResult> {
  const driver = await activeDriver(app)
  await ensureBackofficeSchema(db)
  if (driver.name === 'rowscope-pg') await ensureRowScopeTable(app, db)

  const refs = tenantRefs(count)
  for (const ref of refs) {
    await insertTenantRow(db, ref)
    await driver.provision(ref as any)
    if (driver.name !== 'rowscope-pg') {
      await driver.migrate(ref as any, { direction: 'up' } as any)
    }
  }
  return { driver: driver.name, ids: refs.map((r) => r.id), refs }
}

const CHUNK = 500

/** Seed `rowsPerTenant` notes per tenant, driver-aware. Row 1 is a per-tenant marker. */
export async function seedNotes(
  app: ApplicationService,
  db: DbService,
  refs: TenantRef[],
  rowsPerTenant: number
): Promise<void> {
  const driver = await activeDriver(app)
  const isRowScope = driver.name === 'rowscope-pg'

  for (const ref of refs) {
    const conn = isRowScope ? db.connection('tenant') : await driver.connect(ref as any)

    // Reset so repeated seeds stay deterministic.
    if (isRowScope) {
      await conn.from('notes').where('tenant_id', ref.id).delete()
    } else {
      await conn.from('notes').delete()
    }

    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < rowsPerTenant; i++) {
      const row: Record<string, unknown> = {
        title: i === 0 ? `marker:${ref.id}` : `note-${i}`,
        body: `bench body ${i}`,
      }
      if (isRowScope) row.tenant_id = ref.id
      rows.push(row)
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      await conn.table('notes').multiInsert(rows.slice(i, i + CHUNK))
    }
  }
}

/**
 * Seed `rowsPerTenant` notes whose titles ENCODE the owning tenant id
 * (`t:<ref.id>:<i>`), driver-aware. The isolation tier needs every row in the
 * read window to reveal its owner: `/tenant/notes` returns `id desc limit 20`,
 * so the single `marker:` row (id=1, oldest) never appears and cannot be used
 * to detect a cross-tenant leak. With identifiable titles, any returned row is
 * sufficient to assert ownership.
 */
export async function seedIdentifiableNotes(
  app: ApplicationService,
  db: DbService,
  refs: TenantRef[],
  rowsPerTenant: number
): Promise<void> {
  const driver = await activeDriver(app)
  const isRowScope = driver.name === 'rowscope-pg'

  for (const ref of refs) {
    const conn = isRowScope ? db.connection('tenant') : await driver.connect(ref as any)

    if (isRowScope) {
      await conn.from('notes').where('tenant_id', ref.id).delete()
    } else {
      await conn.from('notes').delete()
    }

    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < rowsPerTenant; i++) {
      const row: Record<string, unknown> = { title: `t:${ref.id}:${i}`, body: `bench body ${i}` }
      if (isRowScope) row.tenant_id = ref.id
      rows.push(row)
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      await conn.table('notes').multiInsert(rows.slice(i, i + CHUNK))
    }
  }
}

/** Prefix a note title carries when seeded by `seedIdentifiableNotes`. */
export function identifiableTitlePrefix(tenantId: string): string {
  return `t:${tenantId}:`
}

/** High-level: provision N tenants and seed M rows each. */
export async function seedAll(
  app: ApplicationService,
  db: DbService,
  opts: { tenants: number; rows: number }
): Promise<SeedResult> {
  const result = await provisionTenants(app, db, opts.tenants)
  await seedNotes(app, db, result.refs, opts.rows)
  return result
}

/**
 * Register tenant connections into THIS process's Lucid manager and open each
 * pool. The HTTP server is spawned separately from the seed process, so it must
 * re-register the seeded tenants before requests can route to them — otherwise
 * `TenantAdapter` calls `db.connection('tenant_<id>')` against a manager that
 * never had it added and every tenant route 500s. `select 1` forces the pool
 * open (with the right search_path) so the first measured request isn't a
 * cold-pool hit. Driver-agnostic: schema-pg/database-pg register a per-tenant
 * connection, rowscope-pg returns the shared central connection (no-op).
 */
export async function warmTenantConnections(app: ApplicationService, ids: string[]): Promise<void> {
  const driver = await activeDriver(app)
  for (const id of ids) {
    const client = await driver.connect({ id } as any)
    await client.rawQuery('select 1')
  }
}
