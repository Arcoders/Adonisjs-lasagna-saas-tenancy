import env from '#start/env'
import multitenancyConfig from '#config/multitenancy'
import { defineConfig } from '@adonisjs/lucid'

const baseConnection = {
  client: 'pg',
  connection: {
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD'),
    database: env.get('DB_DATABASE'),
  },
  migrations: {
    naturalSort: true,
    paths: ['./database/migrations/backoffice'],
  },
} as const

// Pool sizing: backoffice/central are *shared* connections used by every
// request, so they get a generous pool. The `tenant` template is cloned per
// tenant — keeping its pool small + aggressively idle-closing avoids
// exhausting Postgres' `max_connections` when many tenants are live
// (LRU cap × max_per_pool grows fast: 50 × 3 = 150 worst-case, but idle
// connections close in 5s so steady-state stays well under PG's default 100).
const sharedPool = { pool: { min: 0, max: 20, idleTimeoutMillis: 10_000 } } as const
const tenantTemplatePool = { pool: { min: 0, max: 3, idleTimeoutMillis: 5_000 } } as const

export default defineConfig({
  connection: 'tenant',
  connections: {
    // Shared global data (countries, plans, etc.)
    [multitenancyConfig.centralConnectionName]: {
      ...baseConnection,
      ...sharedPool,
      searchPath: [multitenancyConfig.centralSchemaName],
    },

    // Backoffice: tenants registry + satellite tables.
    [multitenancyConfig.backofficeConnectionName]: {
      ...baseConnection,
      ...sharedPool,
      searchPath: [multitenancyConfig.backofficeSchemaName],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/backoffice'],
      },
    },

    // Template config — the package clones this when materialising tenant_<uuid> connections.
    tenant: {
      ...baseConnection,
      ...tenantTemplatePool,
      searchPath: ['public'],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/tenant'],
      },
    },
  },
})
