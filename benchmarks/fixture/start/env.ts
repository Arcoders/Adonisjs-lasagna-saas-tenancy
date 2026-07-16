import { Env } from '@adonisjs/core/env'

/**
 * Bench-local defaults. Applied only when a variable is unset, so a real CI
 * environment or an explicit `BENCH_DRIVER=… DB_PORT=… npm run bench:*` always
 * wins. The defaults point at the dedicated bench services from
 * `docker-compose.yml` (Postgres 5544 / Redis 6390 / DB lasagna_bench) so a
 * fresh checkout runs against the throwaway containers with zero config.
 *
 * NODE_ENV defaults to `development`, not `test`: the rate-limit middleware
 * bypasses itself under `test`, and we want the real Redis pipeline measured.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3344',
  HOST: '127.0.0.1',
  APP_KEY: 'bench-app-key-32-characters-long!',
  LOG_LEVEL: 'error',
  TENANT_HEADER_KEY: 'x-tenant-id',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5544',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_DATABASE: 'lasagna_bench',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6390',
  QUEUE_REDIS_HOST: '127.0.0.1',
  QUEUE_REDIS_PORT: '6390',
  QUEUE_REDIS_DB: '1',
  CACHE_REDIS_HOST: '127.0.0.1',
  CACHE_REDIS_PORT: '6390',
  CACHE_REDIS_DB: '2',
}
for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) process.env[key] = value
}

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),

  TENANT_HEADER_KEY: Env.schema.string(),

  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),

  QUEUE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  QUEUE_REDIS_PORT: Env.schema.number(),
  QUEUE_REDIS_DB: Env.schema.number(),

  CACHE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  CACHE_REDIS_PORT: Env.schema.number(),
  CACHE_REDIS_DB: Env.schema.number(),
})
