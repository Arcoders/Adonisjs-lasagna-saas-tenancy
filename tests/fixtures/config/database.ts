import env from '../start/env.js'
import multitenancyConfig from './multitenancy.js'
import { defineConfig } from '@adonisjs/lucid'

const defaultConnectionOptions = {
  client: 'pg',
  connection: {
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD'),
    database: env.get('DB_DATABASE'),
  },
} as const

// Pool sizing: PostgreSQL's default `max_connections` is 100. The
// integration suite materialises tens of tenant connections via
// `SchemaPgDriver.connect()`; with Knex's default `max: 10` per
// connection, even a modest concurrency burst (cross_tenant_e2e:
// 5 tenants × 20 concurrent writes) saturates the cluster and PG
// starts returning SQLSTATE 53300 "too many clients already". Pin
// per-connection pools small + aggressively idle-close so we stay
// well under the cluster's cap even with many tenants live.
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
      // Tenant migrations run by `driver.migrate()` (used by
      // `CloneService.clone()` and the integration tenant:migrate
      // command tests). A single migration creates a `notes` table
      // so cross-schema copy tests can verify real data movement.
      // Path is relative to the AdonisJS app root (the fixture dir),
      // not to the CWD of the spawned `tsx bin/test.integration.ts`.
      migrations: {
        paths: ['./database/migrations/tenant'],
        naturalSort: true,
      },
    },
  },
})
