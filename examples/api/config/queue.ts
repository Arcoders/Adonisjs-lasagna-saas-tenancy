import { defineConfig, drivers } from '@adonisjs/queue'

export default defineConfig({
  default: 'redis',

  adapters: {
    redis: drivers.redis({
      connectionName: 'queue',
    }),
  },

  worker: {
    concurrency: 2,
    idleDelay: '1s',
  },

  defaultJobOptions: {
    maxRetries: 3,
  },
})
