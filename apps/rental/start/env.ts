import { Env } from '@adonisjs/core/env'

/**
 * Environment contract for Karimoto. Required keys fail boot when missing;
 * optional keys default in config so a copy of `.env.example` boots straight
 * away. Provider keys (Stripe, Anthropic) are optional: absent, the app runs on
 * the in-process mock providers registered in AppProvider; present, the same
 * code paths dial the real services.
 */
export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  APP_KEY: Env.schema.string(),

  // ─── Multitenancy ───────────────────────────────────────────────
  TENANT_HEADER_KEY: Env.schema.string(),
  APP_DOMAIN: Env.schema.string(),
  // Impersonation signing secret (>= 32 chars). Optional in dev (a fixed dev
  // secret is used); a real deploy MUST set it from a secret manager.
  IMPERSONATION_SECRET: Env.schema.string.optional(),

  // ─── PostgreSQL ─────────────────────────────────────────────────
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  DB_REPLICA_HOST: Env.schema.string.optional({ format: 'host' }),

  // ─── Redis (default / queue / cache logical DBs) ────────────────
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),

  QUEUE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  QUEUE_REDIS_PORT: Env.schema.number(),
  QUEUE_REDIS_DB: Env.schema.number(),

  CACHE_REDIS_HOST: Env.schema.string({ format: 'host' }),
  CACHE_REDIS_PORT: Env.schema.number(),
  CACHE_REDIS_DB: Env.schema.number(),

  // ─── Backups (optional) ─────────────────────────────────────────
  BACKUP_STORAGE_PATH: Env.schema.string.optional(),
  BACKUP_S3_ENABLED: Env.schema.boolean.optional(),
  BACKUP_S3_BUCKET: Env.schema.string.optional(),
  BACKUP_S3_REGION: Env.schema.string.optional(),
  BACKUP_S3_ENDPOINT: Env.schema.string.optional(),
  AWS_ACCESS_KEY_ID: Env.schema.string.optional(),
  AWS_SECRET_ACCESS_KEY: Env.schema.string.optional(),

  // Seed a demo staff user inside every tenant schema at migrate time. Off by
  // default so a real deploy never grows well-known credentials.
  DEMO_SEED_TENANT_USERS: Env.schema.boolean.optional(),

  // ─── Billing (Stripe) — optional, defaults to the offline mock ──
  BILLING_DRIVER: Env.schema.string.optional(),
  STRIPE_API_KEY: Env.schema.string.optional(),
  STRIPE_WEBHOOK_SECRET: Env.schema.string.optional(),

  // ─── AI — optional, defaults to the offline mock ────────────────
  // ANTHROPIC_API_KEY binds the Claude provider; DEEPSEEK_API_KEY binds DeepSeek
  // (OpenAI-compatible). Set either to stream a real model instead of the mock.
  ANTHROPIC_API_KEY: Env.schema.string.optional(),
  DEEPSEEK_API_KEY: Env.schema.string.optional(),

  // ─── Mail (MailCatcher in dev, real SMTP in prod) ───────────────
  MAILCATCHER_HOST: Env.schema.string.optional({ format: 'host' }),
  MAILCATCHER_PORT: Env.schema.number.optional(),
  MAIL_FROM_ADDRESS: Env.schema.string.optional(),
  MAIL_FROM_NAME: Env.schema.string.optional(),
})
