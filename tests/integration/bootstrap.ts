import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import type { Config } from '@japa/runner/types'

export const plugins: Config['plugins'] = [assert(), apiClient(), pluginAdonisJS(app)]

/**
 * Create the schemas and tables the integration suite expects on a clean
 * Postgres instance. CI spins up an empty `postgres:16-alpine` per job, so
 * we can't rely on prior state — we provision exactly what the helpers in
 * `tests/integration/helpers/tenant.ts` and the satellite-table services
 * need (`backoffice.tenants` plus the satellite tables exercised by the
 * branding/feature_flag/sso/metrics/webhook specs). Idempotent: running
 * twice is a no-op.
 */
async function ensureBackofficeSchema(): Promise<void> {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  await db.rawQuery('CREATE SCHEMA IF NOT EXISTS backoffice')
  // pgcrypto powers `gen_random_uuid()` defaults below — install once into
  // the public schema so every table that references it can resolve the
  // function regardless of `search_path` ordering.
  await db.rawQuery('CREATE EXTENSION IF NOT EXISTS pgcrypto')

  // Mirror the canonical schemas defined under stubs/migrations/. Kept in
  // sync with those stubs by hand — when stubs change, update here too.
  const ddl = [
    `CREATE TABLE IF NOT EXISTS backoffice.tenants (
       id            uuid PRIMARY KEY,
       name          varchar(255) NOT NULL,
       email         varchar(255) NOT NULL,
       status        varchar(255) NOT NULL,
       custom_domain varchar(255),
       created_at    timestamptz NOT NULL DEFAULT now(),
       updated_at    timestamptz NOT NULL DEFAULT now(),
       deleted_at    timestamptz
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_brandings (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL UNIQUE,
       from_name      varchar(255),
       from_email     varchar(255),
       logo_url       text,
       primary_color  varchar(7),
       support_url    text,
       email_footer   jsonb,
       created_at     timestamptz NOT NULL DEFAULT now(),
       updated_at     timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_feature_flags (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid NOT NULL,
       flag        varchar(255) NOT NULL,
       enabled     boolean NOT NULL DEFAULT false,
       config      jsonb,
       created_at  timestamptz NOT NULL DEFAULT now(),
       updated_at  timestamptz NOT NULL DEFAULT now(),
       UNIQUE(tenant_id, flag)
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_webhooks (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid NOT NULL,
       url         varchar(255) NOT NULL,
       events      text[] NOT NULL DEFAULT '{}',
       secret      text,
       enabled     boolean NOT NULL DEFAULT true,
       created_at  timestamptz NOT NULL DEFAULT now(),
       updated_at  timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_webhook_deliveries (
       id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       webhook_id    uuid NOT NULL REFERENCES backoffice.tenant_webhooks(id) ON DELETE CASCADE,
       event         varchar(255) NOT NULL,
       payload       jsonb NOT NULL,
       status_code   integer,
       response_body text,
       attempt       integer NOT NULL DEFAULT 1,
       status        varchar(20) NOT NULL DEFAULT 'pending',
       next_retry_at timestamptz,
       created_at    timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_sso_configs (
       id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id     uuid NOT NULL UNIQUE,
       provider      varchar(255) NOT NULL,
       client_id     varchar(255) NOT NULL,
       client_secret text NOT NULL,
       issuer_url    text NOT NULL,
       redirect_uri  text NOT NULL,
       scopes        text[] NOT NULL DEFAULT '{}',
       enabled       boolean NOT NULL DEFAULT true,
       created_at    timestamptz NOT NULL DEFAULT now(),
       updated_at    timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_metrics (
       id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       uuid NOT NULL,
       period          date NOT NULL,
       request_count   bigint NOT NULL DEFAULT 0,
       error_count     bigint NOT NULL DEFAULT 0,
       bandwidth_bytes bigint NOT NULL DEFAULT 0,
       created_at      timestamptz NOT NULL DEFAULT now(),
       UNIQUE(tenant_id, period)
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_audit_logs (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid,
       actor_type  varchar(255) NOT NULL,
       actor_id    uuid,
       action      varchar(255) NOT NULL,
       metadata    jsonb,
       ip_address  varchar(255),
       created_at  timestamptz NOT NULL DEFAULT now()
     )`,
    // Billing satellite — kept in sync with stubs/migrations/create_*.stub
    `CREATE TABLE IF NOT EXISTS backoffice.tenant_plans (
       tenant_id   uuid PRIMARY KEY,
       plan_name   varchar(255) NOT NULL,
       source      varchar(255) NOT NULL DEFAULT 'manual',
       assigned_at timestamptz NOT NULL DEFAULT now(),
       expires_at  timestamptz
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.stripe_customers (
       tenant_id              uuid PRIMARY KEY,
       stripe_customer_id     varchar(255) NOT NULL UNIQUE,
       default_payment_method varchar(255),
       currency               varchar(255),
       created_at             timestamptz NOT NULL DEFAULT now(),
       deleted_at             timestamptz
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.stripe_subscriptions (
       stripe_subscription_id varchar(255) PRIMARY KEY,
       tenant_id              uuid NOT NULL REFERENCES backoffice.stripe_customers(tenant_id) ON DELETE RESTRICT,
       status                 varchar(255) NOT NULL,
       current_period_start   timestamptz NOT NULL,
       current_period_end     timestamptz NOT NULL,
       cancel_at_period_end   boolean NOT NULL DEFAULT false,
       cancel_at              timestamptz,
       canceled_at            timestamptz,
       trial_end              timestamptz,
       plan_name              varchar(255) NOT NULL,
       last_event_at          timestamptz NOT NULL,
       raw                    jsonb NOT NULL,
       updated_at             timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.stripe_processed_events (
       event_id     varchar(255) PRIMARY KEY,
       event_type   varchar(255) NOT NULL,
       processed_at timestamptz NOT NULL DEFAULT now(),
       completed_at timestamptz,
       tenant_id    uuid,
       attempts     integer NOT NULL DEFAULT 0,
       last_error   text,
       status       varchar(20) NOT NULL DEFAULT 'pending',
       payload      jsonb
     )`,
    `CREATE TABLE IF NOT EXISTS backoffice.stripe_meter_events (
       id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id         uuid NOT NULL,
       meter_event_name  varchar(255) NOT NULL,
       quantity          bigint NOT NULL,
       idempotency_key   varchar(255) NOT NULL UNIQUE,
       reported_at       timestamptz,
       status            varchar(20) NOT NULL DEFAULT 'pending',
       last_error        text,
       attempts          integer NOT NULL DEFAULT 0,
       created_at        timestamptz NOT NULL DEFAULT now()
     )`,
  ]

  for (const stmt of ddl) {
    await db.rawQuery(stmt)
  }

  // Mirror the append-only trigger from the audit-logs migration stub
  // so integration tests exercise the same enforcement that ships to
  // host apps. Idempotent: drops and recreates on every test boot.
  await db.rawQuery(`
    CREATE OR REPLACE FUNCTION backoffice.tenant_audit_logs_no_mutate()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'tenant_audit_logs is append-only; UPDATE/DELETE is forbidden'
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await db.rawQuery('DROP TRIGGER IF EXISTS tenant_audit_logs_no_update ON backoffice.tenant_audit_logs')
  await db.rawQuery(`
    CREATE TRIGGER tenant_audit_logs_no_update
    BEFORE UPDATE ON backoffice.tenant_audit_logs
    FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate()
  `)
  await db.rawQuery('DROP TRIGGER IF EXISTS tenant_audit_logs_no_delete ON backoffice.tenant_audit_logs')
  await db.rawQuery(`
    CREATE TRIGGER tenant_audit_logs_no_delete
    BEFORE DELETE ON backoffice.tenant_audit_logs
    FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate()
  `)
  await db.rawQuery('DROP TRIGGER IF EXISTS tenant_audit_logs_no_truncate ON backoffice.tenant_audit_logs')
  await db.rawQuery(`
    CREATE TRIGGER tenant_audit_logs_no_truncate
    BEFORE TRUNCATE ON backoffice.tenant_audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate()
  `)
}

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [ensureBackofficeSchema],
  teardown: [],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'integration') {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
