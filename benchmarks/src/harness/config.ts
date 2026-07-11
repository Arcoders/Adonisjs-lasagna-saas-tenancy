/**
 * Centralized reading of bench sizing knobs from the environment, so every tier
 * sizes consistently and CI can shrink the run with a few env vars.
 *
 * CI_MODE shrinks the heavy tiers (smaller tenant counts, skip catalog 5k).
 */
export const CI_MODE = process.env.BENCH_CI === '1' || process.env.CI === 'true'

const int = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Like `int` but keeps fractions (e.g. BENCH_SOAK_HOURS=0.1 for a smoke soak). */
const float = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const sizes = {
  /** Tenants + rows for the DB query tier. */
  db: {
    tenants: int('BENCH_DB_TENANTS', CI_MODE ? 20 : 50),
    rows: int('BENCH_DB_ROWS', CI_MODE ? 200 : 1000),
  },
  /** Churn tier: tenant-connection-cap sweep + per-step concurrency. */
  churn: {
    caps: (process.env.BENCH_CHURN_CAPS ?? (CI_MODE ? '25,50' : '25,50,100'))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    concurrency: int('BENCH_CHURN_CONCURRENCY', CI_MODE ? 8 : 16),
    opsPerStep: int('BENCH_CHURN_OPS', CI_MODE ? 400 : 2000),
  },
  /** Connection-budget tier: tenant counts to provision/touch. */
  budget: {
    counts: (process.env.BENCH_BUDGET_COUNTS ?? (CI_MODE ? '100,500' : '100,500,2000'))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  },
  /** Catalog-bloat tier: schema counts. 5k is local-only (slow). */
  catalog: {
    schemaCounts: (process.env.BENCH_CATALOG_COUNTS ?? (CI_MODE ? '100,1000' : '100,1000,5000'))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    tablesPerSchema: int('BENCH_CATALOG_TABLES', 4),
  },
  /** HTTP tier. */
  http: {
    tenants: int('BENCH_HTTP_TENANTS', CI_MODE ? 20 : 50),
    rows: int('BENCH_HTTP_ROWS', CI_MODE ? 50 : 200),
    connections: int('BENCH_HTTP_CONNECTIONS', CI_MODE ? 10 : 25),
    durationSec: int('BENCH_HTTP_DURATION', CI_MODE ? 5 : 10),
  },
  /**
   * Isolation tier: concurrent requests rotating x-tenant-id across the seeded
   * tenants, each response asserted to contain only its tenant's rows.
   */
  iso: {
    tenants: int('BENCH_ISO_TENANTS', CI_MODE ? 20 : 50),
    rows: int('BENCH_ISO_ROWS', CI_MODE ? 30 : 50),
    requests: int('BENCH_ISO_REQUESTS', CI_MODE ? 2000 : 5000),
    concurrency: int('BENCH_ISO_CONCURRENCY', CI_MODE ? 16 : 32),
    /** Inject a deliberately-wrong correlation to prove the check catches leaks. */
    selftest: process.env.BENCH_ISO_SELFTEST === '1',
    /**
     * Ceiling on non-200 responses (fraction of total). The isolation check
     * only inspects 200s, so a run where most cross-tenant requests error out
     * could read `isolationCheck: PASS` vacuously. Above this rate the run
     * fails instead of rubber-stamping.
     */
    maxErrorRate: float('BENCH_ISO_MAX_ERROR_RATE', 0.05),
  },
  /** Connection-budget burst tier: concurrent workers over distinct tenants. */
  burst: {
    workers: int('BENCH_BURST_WORKERS', CI_MODE ? 16 : 32),
    /** Max tenants to drive when probing the max_connections failure mode. */
    saturateTo: int('BENCH_BURST_SATURATE_TO', CI_MODE ? 150 : 320),
  },
  /** Soak tier: long-running stability sampling. */
  soak: {
    hours: float('BENCH_SOAK_HOURS', CI_MODE ? 0.05 : 0.1),
    intervalSec: int('BENCH_SOAK_INTERVAL_S', 15),
    concurrency: int('BENCH_SOAK_CONCURRENCY', CI_MODE ? 8 : 16),
  },
  /** Resilience tier: container-level fault injection. */
  resilience: {
    enabled: process.env.BENCH_RESILIENCE === '1',
    redisContainer: process.env.BENCH_REDIS_CONTAINER ?? 'benchmarks-redis-1',
    pgContainer: process.env.BENCH_PG_CONTAINER ?? 'benchmarks-postgres-1',
    recoveryTimeoutMs: int('BENCH_RESILIENCE_RECOVERY_MS', 30_000),
  },
}

export const DRIVER = process.env.BENCH_DRIVER ?? 'schema-pg'

/**
 * NODE_ENV handed to the spawned HTTP fixture. Default `development` so the
 * rate-limit middleware runs its real Redis pipeline (it short-circuits only in
 * the test env); set `production` to also capture the production framework path.
 */
export const HTTP_NODE_ENV = process.env.BENCH_HTTP_NODE_ENV ?? 'development'
