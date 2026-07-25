import env from '#start/env'
import multitenancyConfig from '#config/multitenancy'
import { defineConfig } from '@adonisjs/lucid'

// No `as const` here: it would freeze `migrations.paths` into a readonly tuple,
// which Lucid's config type rejects (it wants a mutable string[]). DB_PASSWORD
// is optional (local Postgres often trusts the socket); omit the key when unset
// rather than passing `undefined`, which exactOptionalPropertyTypes rejects.
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

// Backoffice/central are shared connections used by every request → generous
// pool. The `tenant` template is cloned per tenant → small pool, aggressive
// idle-close so a live fleet of tenants never exhausts PG's max_connections.
const sharedPool = { pool: { min: 0, max: 20, idleTimeoutMillis: 10_000 } } as const
const tenantTemplatePool = { pool: { min: 0, max: 3, idleTimeoutMillis: 5_000 } } as const

export default defineConfig({
  connection: 'tenant',
  connections: {
    // Central (`public`): the shared, cross-tenant car catalog (car_makes /
    // car_models). Migrations run with `node ace migration:run --connection=public`.
    [multitenancyConfig.centralConnectionName]: {
      ...baseConnection,
      ...sharedPool,
      searchPath: [multitenancyConfig.centralSchemaName],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/central'],
      },
    },

    // Backoffice: tenants registry + satellite backoffice tables.
    [multitenancyConfig.backofficeConnectionName]: {
      ...baseConnection,
      ...sharedPool,
      searchPath: [multitenancyConfig.backofficeSchemaName],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/backoffice'],
      },
    },

    // Template: the package clones this when materialising each tenant_<uuid>
    // connection. Its migrations run once per tenant schema.
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
