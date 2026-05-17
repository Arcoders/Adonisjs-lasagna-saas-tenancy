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
  },
})
