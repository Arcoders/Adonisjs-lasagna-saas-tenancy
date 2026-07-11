import env from '#start/env'
import multitenancyConfig from '#config/multitenancy'
import { defineConfig } from '@adonisjs/lucid'

// No `as const` here: it would freeze `migrations.paths` into a readonly
// tuple, which Lucid's config type rejects (it wants a mutable string[]).
// The client literal is pinned individually instead.
// DB_PASSWORD is optional (local Postgres often trusts the socket). Omit the
// key when unset rather than passing `undefined`, which exactOptionalPropertyTypes
// rejects against Lucid's `password?: string`.
const dbPassword = env.get('DB_PASSWORD')

const baseConnection = {
  client: 'pg' as const,
  connection: {
    host: env.get('DB_HOST'),
    port: env.get('DB_PORT'),
    user: env.get('DB_USER'),
    ...(dbPassword !== undefined ? { password: dbPassword } : {}),
    database: env.get('DB_DATABASE'),
  },
  migrations: {
    naturalSort: true,
    paths: ['./database/migrations/backoffice'],
  },
}

// Pool sizing: backoffice/central are *shared* connections used by every
// request, so they get a generous pool. The `tenant` template is cloned per
// tenant, so keeping its pool small and aggressively idle-closing avoids
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

    // Template config: the package clones this when materialising tenant_<uuid> connections.
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
