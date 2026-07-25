import env from '#start/env'
import { defineConfig } from '@adonisjs/redis'
import type { InferConnections } from '@adonisjs/redis/types'

// REDIS_PASSWORD is optional (local Redis runs open). Spread the key in only
// when set, rather than passing `undefined`, which exactOptionalPropertyTypes
// rejects against ioredis' `password?: string`.
const redisPassword = env.get('REDIS_PASSWORD')
const redisAuth = redisPassword !== undefined ? { password: redisPassword } : {}

const redisConfig = defineConfig({
  connection: 'default',
  connections: {
    default: {
      host: env.get('REDIS_HOST'),
      port: env.get('REDIS_PORT'),
      ...redisAuth,
      db: 0,
      keyPrefix: '',
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
    queue: {
      host: env.get('QUEUE_REDIS_HOST'),
      port: env.get('QUEUE_REDIS_PORT'),
      ...redisAuth,
      db: env.get('QUEUE_REDIS_DB'),
      keyPrefix: '',
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
    cache: {
      host: env.get('CACHE_REDIS_HOST'),
      port: env.get('CACHE_REDIS_PORT'),
      ...redisAuth,
      db: env.get('CACHE_REDIS_DB'),
      keyPrefix: '',
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
  },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
  export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
