/**
 * Centralized reading of bench sizing knobs from the environment, so every tier
 * sizes consistently and CI can shrink the run with a few env vars.
 *
 * CI_MODE shrinks the heavy tiers (smaller tenant counts, skip catalog 5k).
 */
export const CI_MODE = process.env.BENCH_CI === '1' || process.env.CI === 'true'

const int = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
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
}

export const DRIVER = process.env.BENCH_DRIVER ?? 'schema-pg'
