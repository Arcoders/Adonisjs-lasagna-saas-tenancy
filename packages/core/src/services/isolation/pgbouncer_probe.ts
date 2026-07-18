import { getConfig } from '../../config.js'
import type { PgBouncerConfig } from '../../types/config/isolation.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/**
 * The detected/declared PgBouncer posture (F3). Purely INFORMATIONAL: it records
 * how the database is fronted and confirms the tenant routing path is safe under
 * it. It never changes a cap, a ceiling, or the connection budget.
 */
export interface PgBouncerPosture {
  /** The effective pooling mode. `unknown` when `auto` could not confirm one. */
  mode: 'transaction' | 'session' | 'unknown' | 'off'
  /** Where the mode came from. */
  source: 'declared' | 'auto-inconclusive' | 'disabled'
  /**
   * Whether the kernel's tenant routing is safe under this posture. Always true:
   * the tenant GUC is applied as a bound-parameter `set_config(..., isLocal=true)`
   * per transaction (see `services/isolation/rls.ts`), which is transaction-pooling
   * -safe, and nothing on the request path relies on server-side prepared
   * statements that survive across transactions.
   */
  transactionSafe: boolean
  /** A human-readable summary for the log line and the doctor check. */
  note: string
}

/**
 * Determine the PgBouncer posture from config alone. Pure + fail-closed:
 *  - `off` / absent → disabled.
 *  - `transaction` / `session` → the operator-declared mode is recorded and
 *    reported as safe (the routing path is pooler-safe either way).
 *  - `auto` → returns `unknown`. Reliable pooling-mode detection from an ordinary
 *    data connection is not possible (a normal connection cannot see PgBouncer's
 *    admin console), so `auto` never ASSUMES transaction pooling; it advises an
 *    explicit declaration. Either way the routing path stays transaction-safe and
 *    NO cap is raised by detection.
 */
export function determinePgBouncerPosture(cfg: PgBouncerConfig | undefined): PgBouncerPosture {
  if (!cfg || cfg.mode === undefined || cfg.mode === 'off') {
    return {
      mode: 'off',
      source: 'disabled',
      transactionSafe: true,
      note: 'PgBouncer awareness is off.',
    }
  }

  if (cfg.mode === 'transaction' || cfg.mode === 'session') {
    return {
      mode: cfg.mode,
      source: 'declared',
      transactionSafe: true,
      note:
        `PgBouncer mode: ${cfg.mode} (operator-declared). The tenant GUC is a bound-parameter ` +
        `set_config per transaction, which is ${cfg.mode}-pooling-safe; the request path relies ` +
        `on no cross-transaction server-side prepared statements. No cap was raised by detection.`,
    }
  }

  return {
    mode: 'unknown',
    source: 'auto-inconclusive',
    transactionSafe: true,
    note:
      'PgBouncer mode: auto — reliable pooling-mode detection from a data connection is not ' +
      'possible, so transaction pooling is NOT assumed. Declare mode: "transaction" or "session" ' +
      'explicitly. The tenant routing path is transaction-pooling-safe regardless, and detection ' +
      'never raises a cap or the ceiling.',
  }
}

/** Injected reachability check, so the boot probe is unit-testable without Lucid. */
export interface PgBouncerProbeDeps {
  ping?: () => Promise<void>
}

let detected: PgBouncerPosture | undefined

/**
 * Boot probe (F3): confirm the database is reachable, then record + log the
 * PgBouncer posture. Fail-closed: an unreachable database is logged and degraded
 * (the app's own DB boot will surface a hard error elsewhere), never rethrown from
 * here, and the probe changes no cap. Wired from `isolationWiring.ready()` behind
 * `app.booted()`.
 */
export async function probePgBouncerAtBoot(deps: PgBouncerProbeDeps = {}): Promise<PgBouncerPosture> {
  const posture = determinePgBouncerPosture(getConfig().isolation.pgBouncer)
  detected = posture

  try {
    const ping = deps.ping ?? defaultPing
    await ping()
  } catch (error) {
    const logger = await lazyLogger()
    logger?.warn(
      { err: (error as Error)?.message ?? String(error) },
      'multitenancy: PgBouncer probe could not reach the database; reporting posture from config only.'
    )
  }

  const logger = await lazyLogger()
  logger?.info({ pgBouncerMode: posture.mode, source: posture.source }, `multitenancy: ${posture.note}`)
  return posture
}

/** The last posture the boot probe recorded, for the doctor check. */
export function getDetectedPgBouncerPosture(): PgBouncerPosture | undefined {
  return detected
}

/** Test seam: clear the recorded posture between specs. */
export function __resetPgBouncerPostureForTests(): void {
  detected = undefined
}

async function defaultPing(): Promise<void> {
  const { default: db } = await import('@adonisjs/lucid/services/db')
  const connection = getConfig().centralConnectionName
  await db.connection(connection).rawQuery('SELECT 1')
}
