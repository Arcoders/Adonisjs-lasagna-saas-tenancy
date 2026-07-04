import db from '@adonisjs/lucid/services/db'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import WormLedgerWriter, { type WormDb } from '@adonisjs-lasagna/saas-tenancy/worm-ledger'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import CryptoService from '../../src/services/crypto_service.js'
import RekekService from '../../src/services/rekek_service.js'
import EnvKeyProvider from '../../src/services/env_key_provider.js'
import PgWrappedDekStore, {
  type CryptoDb,
  type CryptoStoreDriver,
} from '../../src/services/pg_wrapped_dek_store.js'
import WormShredLedger from '../../src/services/worm_shred_ledger.js'
import { CRYPTO_WRAPPED_DEKS_TABLE } from '../../src/constants.js'
import type { ErasabilityResolver } from '../../src/types/erasability.js'

/**
 * Shared real-Postgres setup for the crypto integration specs. The kit boots core's
 * fixture (a real Ignitor + PG) but does NOT run crypto's satellite migrations, so
 * each spec provisions its own per-tenant schema + wrapped-DEK table (mirroring
 * `tenant_migrations/..._create_crypto_wrapped_deks_table.ts`) and the shared
 * `backoffice.worm_ledger` table + append-only triggers (mirroring core's
 * `create_worm_ledger_table.stub`) in `group.setup`, then drops them in teardown.
 * The specs construct the REAL services (PgWrappedDekStore, CryptoService, the shared
 * WormLedgerWriter) so the actual raw-SQL paths run, not an in-memory double. They
 * self-skip when Postgres is unreachable (local) and run in CI. APP_KEY is set by the
 * fixture env, so the env KeyProvider derives its per-tenant KEK for real.
 */

export function centralConn(): string {
  return getConfig().centralConnectionName
}

/** A fake tenant: the store + the env provider only ever read `.id`. */
export function tenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

/** Rows from a Lucid rawQuery result (node-pg `{ rows }` or a bare array). */
export function rowsOfResult(res: unknown): Array<Record<string, unknown>> {
  const rows = (res as { rows?: unknown } | null)?.rows
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
  return Array.isArray(res) ? (res as Array<Record<string, unknown>>) : []
}

type Client = ReturnType<typeof db.connection>

/** Is the fixture's Postgres reachable? Specs `.skip` themselves when not. */
export async function probePg(): Promise<boolean> {
  try {
    await db.connection(centralConn()).rawQuery('SELECT 1')
    return true
  } catch {
    return false
  }
}

/**
 * The wrapped-DEK table DDL, mirroring the per-tenant migration. Created on a
 * connection whose search_path is the tenant schema, so the bare name lands there
 * exactly as the production migration does through the tenant search_path.
 */
function wrappedDeksDdl(): string {
  const t = CRYPTO_WRAPPED_DEKS_TABLE
  return `CREATE TABLE ${t} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id text NOT NULL,
    category text NOT NULL,
    wrapped_dek text,
    kek_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    shredded_at timestamptz,
    CONSTRAINT ${t}_live_has_key CHECK (shredded_at IS NOT NULL OR wrapped_dek IS NOT NULL)
  )`
}

function wrappedDeksIndexDdl(): string {
  const t = CRYPTO_WRAPPED_DEKS_TABLE
  return `CREATE UNIQUE INDEX ${t}_live_subject_category ON ${t} (subject_id, category) WHERE shredded_at IS NULL`
}

export interface TenantSchema {
  readonly schema: string
  readonly conn: string
}

/**
 * Create a tenant schema + its wrapped-DEK table on a dedicated connection whose
 * search_path is that schema. Returns the placement the driver fake routes to.
 */
export async function addTenantSchema(schema: string, conn: string): Promise<TenantSchema> {
  const primary = centralConn()
  const client = db.connection(primary)
  await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  const template = db.manager.get(primary)?.config
  db.manager.add(conn, { ...template, searchPath: [schema] } as never)
  const tenantClient = db.connection(conn)
  await tenantClient.rawQuery(wrappedDeksDdl())
  await tenantClient.rawQuery(wrappedDeksIndexDdl())
  return { schema, conn }
}

export async function dropTenantSchema(schema: string, conn: string): Promise<void> {
  await db
    .connection(centralConn())
    .rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    .catch(() => {})
  if (db.manager.has(conn)) await db.manager.release(conn)
}

const WORM_TRIGGERS = [
  `CREATE OR REPLACE FUNCTION backoffice.worm_ledger_no_mutate()
   RETURNS TRIGGER AS $$
   BEGIN
     RAISE EXCEPTION 'worm_ledger is append-only; UPDATE/DELETE is forbidden'
       USING ERRCODE = 'insufficient_privilege';
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER worm_ledger_no_update BEFORE UPDATE ON backoffice.worm_ledger
   FOR EACH ROW EXECUTE FUNCTION backoffice.worm_ledger_no_mutate()`,
  `CREATE TRIGGER worm_ledger_no_delete BEFORE DELETE ON backoffice.worm_ledger
   FOR EACH ROW EXECUTE FUNCTION backoffice.worm_ledger_no_mutate()`,
  `CREATE TRIGGER worm_ledger_no_truncate BEFORE TRUNCATE ON backoffice.worm_ledger
   FOR EACH STATEMENT EXECUTE FUNCTION backoffice.worm_ledger_no_mutate()`,
]

const WORM_TABLE = `
  CREATE TABLE backoffice.worm_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    seq bigint NOT NULL,
    checksum char(64) NOT NULL,
    prev_checksum char(64),
    action text NOT NULL,
    subject_hash char(64),
    category text,
    reason text,
    metadata jsonb NOT NULL DEFAULT '{}',
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, seq)
  )`

export async function dropWormLedger(): Promise<void> {
  const client = db.connection(centralConn())
  await client.rawQuery('DROP TABLE IF EXISTS backoffice.worm_ledger CASCADE').catch(() => {})
  await client
    .rawQuery('DROP FUNCTION IF EXISTS backoffice.worm_ledger_no_mutate() CASCADE')
    .catch(() => {})
}

/** Provision the shared WORM ledger table + append-only triggers (idempotent). */
export async function createWormLedger(): Promise<void> {
  await dropWormLedger()
  const client = db.connection(centralConn())
  await client.rawQuery(WORM_TABLE)
  for (const sql of WORM_TRIGGERS) await client.rawQuery(sql)
}

/** A real WormLedgerWriter over the central connection (SQL is schema-qualified `backoffice.worm_ledger`). */
export function realWormWriter(activeScope?: string): WormLedgerWriter {
  return new WormLedgerWriter({
    getDb: async () => db as unknown as WormDb,
    connectionName: centralConn(),
    activeScopeTenantId: () => activeScope,
  })
}

export interface RealServiceOpts {
  /** tenantId -> physical placement; the driver fake routes `tableLocation` by `tenant.id`. */
  readonly routes: Record<string, TenantSchema>
  /** Wire a real WORM shred ledger (needed for shred; omit for pure encrypt/decrypt). */
  readonly withLedger?: boolean
  /** Governance erasability gate (needed for shred). */
  readonly erasabilityResolver?: ErasabilityResolver
}

/**
 * A real CryptoService whose ContextSeal scope is `activeScope`, backed by a real
 * PgWrappedDekStore (routed by `routes`) and the env KeyProvider. Mirrors the vector
 * store spec's `storeAs(activeId)`: one service per active scope.
 */
export function serviceAs(activeScope: string, opts: RealServiceOpts): CryptoService {
  const store = new PgWrappedDekStore({
    getDriver: async () => schemaDriver(opts.routes),
    getDb: async () => db as unknown as CryptoDb,
    activeScopeTenantId: () => activeScope,
  })
  const ledger = opts.withLedger ? new WormShredLedger(realWormWriter(activeScope)) : undefined
  return new CryptoService({
    keyProvider: new EnvKeyProvider(),
    store,
    erasabilityResolver: opts.erasabilityResolver,
    ledger,
  })
}

/** A schema-pg driver fake that routes `tableLocation` by `tenant.id` → placement. */
function schemaDriver(routes: Record<string, TenantSchema>): CryptoStoreDriver {
  return {
    name: 'schema-pg',
    tableLocation: (t) => {
      const placement = routes[t.id]
      if (!placement) throw new Error(`real_crypto_pg: no route configured for tenant '${t.id}'`)
      return { kind: 'schema', schema: placement.schema, connectionName: placement.conn }
    },
  }
}

/** The store + services (a real CryptoService AND RekekService) sharing one driver + scope. */
export interface CryptoHarness {
  readonly store: PgWrappedDekStore
  readonly keyProvider: EnvKeyProvider
  readonly crypto: CryptoService
  readonly rekek: RekekService
}

/** Build a full crypto harness over the real Pg store, for the KEK-rotation specs. */
export function harnessAs(
  activeScope: string,
  opts: { routes: Record<string, TenantSchema> }
): CryptoHarness {
  const store = new PgWrappedDekStore({
    getDriver: async () => schemaDriver(opts.routes),
    getDb: async () => db as unknown as CryptoDb,
    activeScopeTenantId: () => activeScope,
  })
  const keyProvider = new EnvKeyProvider()
  return {
    store,
    keyProvider,
    crypto: new CryptoService({ keyProvider, store }),
    rekek: new RekekService({ keyProvider, store }),
  }
}
