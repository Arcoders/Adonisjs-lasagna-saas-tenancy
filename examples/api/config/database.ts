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

export default defineConfig({
  connection: 'tenant',
  connections: {
    // Shared global data (countries, plans, etc.)
    [multitenancyConfig.centralConnectionName]: {
      ...baseConnection,
      searchPath: [multitenancyConfig.centralSchemaName],
    },

    // Backoffice: tenants registry + satellite tables.
    [multitenancyConfig.backofficeConnectionName]: {
      ...baseConnection,
      searchPath: [multitenancyConfig.backofficeSchemaName],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/backoffice'],
      },
    },

    // Template config — the package clones this when materialising tenant_<uuid> connections.
    tenant: {
      ...baseConnection,
      searchPath: ['public'],
      migrations: {
        naturalSort: true,
        paths: ['./database/migrations/tenant'],
      },
    },
  },
})
