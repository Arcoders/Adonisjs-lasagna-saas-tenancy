import env from '../start/env.js'
import multitenancyConfig from './multitenancy.js'
import { defineConfig } from '@adonisjs/lucid'

// `DB_PASSWORD` is optional in the env schema; Lucid's connection type (with
// exactOptionalPropertyTypes) rejects `password: undefined`, so omit the key
// entirely when it is unset rather than passing an explicit `undefined`.
const dbPassword = env.get('DB_PASSWORD')
const defaultConnectionOptions = {
  client: 'pg',
  connection: {
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    ...(dbPassword !== undefined ? { password: dbPassword } : {}),
    database: env.get('DB_DATABASE'),
  },
} as const

// Shared connections (central + backoffice) get a slightly larger pool; the
// per-tenant template stays deliberately small. The connection budget is
// peak ≈ maxTenantConnections × tenantPoolMax (+ central + backoffice), and
// the bench Postgres is capped at 300, so a small tenant pool keeps the
// cap=100 churn sweep well inside the ceiling. Override the tenant pool via
// BENCH_TENANT_POOL_MAX when measuring intra-tenant parallelism.
const sharedPool = { pool: { min: 0, max: 4, idleTimeoutMillis: 10_000 } } as const
const tenantPoolMax = (() => {
  const raw = Number(process.env.BENCH_TENANT_POOL_MAX)
  return Number.isFinite(raw) && raw > 0 ? raw : 2
})()
const tenantTemplatePool = {
  pool: { min: 0, max: tenantPoolMax, idleTimeoutMillis: 5_000 },
} as const

export default defineConfig({
  connection: 'tenant',
  connections: {
    [multitenancyConfig.centralConnectionName]: {
      ...defaultConnectionOptions,
      ...sharedPool,
      searchPath: [multitenancyConfig.centralSchemaName],
      // rowscope-pg keeps the shared `notes` table in the central schema, so
      // central migrations are run against this connection.
      migrations: {
        paths: ['./database/migrations/central'],
        naturalSort: true,
      },
    },
    [multitenancyConfig.backofficeConnectionName]: {
      ...defaultConnectionOptions,
      ...sharedPool,
      searchPath: [multitenancyConfig.backofficeSchemaName],
    },
    tenant: {
      ...defaultConnectionOptions,
      ...tenantTemplatePool,
      searchPath: ['public'],
      // Per-tenant `notes` migration for schema-pg + database-pg. The cloned
      // per-tenant connection inherits this `migrations` block, so
      // `driver.migrate(tenant, {})` runs it into the tenant schema/database.
      migrations: {
        paths: ['./database/migrations/tenant'],
        naturalSort: true,
      },
    },
  },
})
