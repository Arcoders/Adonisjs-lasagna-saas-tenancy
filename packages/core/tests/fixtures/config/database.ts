import env from '../start/env.js'
import multitenancyConfig from './multitenancy.js'
import { defineConfig } from '@adonisjs/lucid'

// `DB_PASSWORD` is optional (peerless local PG). Under exactOptionalPropertyTypes
// a `password: string | undefined` is not assignable to Lucid's `password?: string`,
// so omit the key entirely when it's unset (runtime-equivalent to passing undefined).
const passwordOption = (pw: string | undefined) => (pw !== undefined ? { password: pw } : {})

const defaultConnectionOptions = {
  client: 'pg',
  connection: {
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    database: env.get('DB_DATABASE'),
    ...passwordOption(env.get('DB_PASSWORD')),
  },
} as const

// Pool caps stay small + aggressive idle-close: PG's default max_connections
// is 100, and Knex's default of 10/connection saturates that under
// cross_tenant_e2e's 5 tenants × 20 concurrent writes (SQLSTATE 53300).
const sharedPool = { pool: { min: 0, max: 8, idleTimeoutMillis: 10_000 } } as const
const tenantTemplatePool = { pool: { min: 0, max: 3, idleTimeoutMillis: 5_000 } } as const

export default defineConfig({
  connection: 'tenant',
  connections: {
    [multitenancyConfig.centralConnectionName]: {
      ...defaultConnectionOptions,
      ...sharedPool,
      searchPath: [multitenancyConfig.centralSchemaName],
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
      // Path is relative to the AdonisJS app root (the fixture dir).
      migrations: {
        paths: ['./database/migrations/tenant'],
        naturalSort: true,
      },
    },
    // Least-privilege connection used ONLY by rowscope_rls.spec.ts to execute
    // the RLS enforcement proof. Defaults to the main DB user (a superuser in
    // local/default setups → the spec self-skips). CI sets RLS_DB_USER to a
    // NOSUPERUSER NOBYPASSRLS role so the proof actually runs. Lazy pool
    // (min: 0) so the role only ever connects when that spec uses it.
    rls_probe: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: process.env.RLS_DB_USER ?? env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
        ...passwordOption(process.env.RLS_DB_PASSWORD ?? env.get('DB_PASSWORD')),
      },
      ...sharedPool,
      searchPath: ['public'],
    },
    // Same least-privilege role as `rls_probe`, but pinned to a SINGLE physical
    // backend (min=max=1) so a transaction and a later bare query provably reuse
    // the same connection — the setup needed to prove the transaction-local GUC
    // does not leak across requests on a pooled connection. Used only by
    // rowscope_rls.spec.ts's no-leak case.
    rls_probe_single: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: process.env.RLS_DB_USER ?? env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
        ...passwordOption(process.env.RLS_DB_PASSWORD ?? env.get('DB_PASSWORD')),
      },
      pool: { min: 1, max: 1, idleTimeoutMillis: 10_000 },
      searchPath: ['public'],
    },
    // SELECT-only role used ONLY by the S3 read-only firewall proof
    // (security_plugin_read_only_role.spec.ts). Defaults to the main DB user (a
    // writable superuser locally → the spec self-skips). CI sets PLUGIN_RO_DB_USER
    // to a role with `default_transaction_read_only = on`, so a write is denied.
    // Lazy pool (min: 0) so the role only connects when that spec runs.
    plugin_ro: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: process.env.PLUGIN_RO_DB_USER ?? env.get('DB_USER'),
        database: env.get('DB_DATABASE'),
        ...passwordOption(process.env.PLUGIN_RO_DB_PASSWORD ?? env.get('DB_PASSWORD')),
      },
      ...sharedPool,
      searchPath: ['public'],
    },
  },
})
