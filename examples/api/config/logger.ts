import env from '#start/env'
import { defineConfig } from '@adonisjs/core/logger'

const loggerConfig = defineConfig({
  default: 'app',
  loggers: {
    app: {
      enabled: true,
      name: env.get('NODE_ENV') === 'test' ? 'test' : 'lasagna-demo',
      level: env.get('LOG_LEVEL'),
    },
  },
})

export default loggerConfig
