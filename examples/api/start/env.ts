import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  APP_KEY: Env.schema.string(),

  TENANT_HEADER_KEY: Env.schema.string(),
  APP_DOMAIN: Env.schema.string(),

  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  // Streaming read replica host. Optional: local dev runs a single Postgres
  // and falls back to DB_HOST; the deploy e2e stack points it at the real
  // standby so replica routing is exercised end to end.
  DB_REPLICA_HOST: Env.schema.string.optional({ format: 'host' }),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  // Optional: local dev runs an open Redis; the deploy e2e stack (and any
  // real deployment) runs requirepass, so the demo must wire it through.
  REDIS_PASSWORD: Env.schema.string.optional(),

  QUEUE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  QUEUE_REDIS_PORT: Env.schema.number(),
  QUEUE_REDIS_DB: Env.schema.number(),

  CACHE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  CACHE_REDIS_PORT: Env.schema.number(),
  CACHE_REDIS_DB: Env.schema.number(),

  BACKUP_STORAGE_PATH: Env.schema.string.optional(),
  BACKUP_S3_ENABLED: Env.schema.boolean.optional(),
  BACKUP_S3_BUCKET: Env.schema.string.optional(),
  BACKUP_S3_REGION: Env.schema.string.optional(),
  BACKUP_S3_ENDPOINT: Env.schema.string.optional(),
  AWS_ACCESS_KEY_ID: Env.schema.string.optional(),
  AWS_SECRET_ACCESS_KEY: Env.schema.string.optional(),

  // Opt-in: when true, the afterMigrate hook seeds a demo user inside every
  // tenant schema it migrates. Default absent = off, so a real deployment
  // never grows well-known credentials by accident. The e2e stacks enable it.
  DEMO_SEED_TENANT_USERS: Env.schema.boolean.optional(),

  // Billing provider selection. Optional: defaults to 'stripe' in config. Lets a
  // deploy pick a provider without a code change (and lets the satellite boot
  // e2e point it at a bogus driver to prove fail-fast boot).
  BILLING_DRIVER: Env.schema.string.optional(),

  // ─── Mail (MailCatcher in dev/test, real SMTP in production) ─────
  MAILCATCHER_HOST: Env.schema.string.optional({ format: 'host' }),
  MAILCATCHER_PORT: Env.schema.number.optional(),
  MAIL_FROM_ADDRESS: Env.schema.string.optional(),
  MAIL_FROM_NAME: Env.schema.string.optional(),
})
