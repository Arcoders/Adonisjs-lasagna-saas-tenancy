import env from '../start/env.js'
import { defineConfig, targets } from '@adonisjs/core/logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default defineConfig({
  default: 'app',

  loggers: {
    app: {
      enabled: true,
      name: 'fixture',
      level: env.get('LOG_LEVEL'),
      transport: {
        targets: targets().pushIf(true, targets.file({ destination: 1 })).toArray(),
      },
    },
  },
}) as any
