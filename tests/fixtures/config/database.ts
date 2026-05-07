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

export default defineConfig({
  connection: 'tenant',
  connections: {
    [multitenancyConfig.centralConnectionName]: {
      ...defaultConnectionOptions,
      searchPath: [multitenancyConfig.centralSchemaName],
    },
    [multitenancyConfig.backofficeConnectionName]: {
      ...defaultConnectionOptions,
      searchPath: [multitenancyConfig.backofficeSchemaName],
    },
    tenant: {
      ...defaultConnectionOptions,
      searchPath: ['public'],
    },
  },
})
