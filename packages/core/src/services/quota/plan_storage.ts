import { getConfig } from '../../config.js'

const lazyTenantPlan = () =>
  import('../../models/satellites/tenant_plan.js').then((m) => m.default)

export type PlanStorageMode = 'config-only' | 'tenant_plans'

let _storageProbe: PlanStorageMode | null = null

/**
 * Decide once per process whether the storage-backed plan resolver is
 * available. With `storage: 'tenant_plans'` we trust the operator and fail
 * loudly on first read if the table is missing. With `storage: 'auto'`
 * (or omitted) we probe `to_regclass`; result is memoised so we don't pay
 * the round-trip on every getPlanFor.
 *
 * Lives in its own module so the probe state (`_storageProbe`) is a single
 * process-wide instance. Tests that need to flip the answer call
 * {@link __resetPlanStorageProbe}.
 */
export async function resolveStorageMode(): Promise<PlanStorageMode> {
  if (_storageProbe) return _storageProbe

  const cfg = getConfig().plans
  const declared = cfg?.storage

  if (declared === 'config-only') {
    _storageProbe = 'config-only'
    return _storageProbe
  }
  if (declared === 'tenant_plans') {
    _storageProbe = 'tenant_plans'
    return _storageProbe
  }

  // 'auto' (or undefined) — probe the table.
  try {
    const TenantPlan = await lazyTenantPlan()
    const conn = TenantPlan.$adapter
    if (!conn) {
      _storageProbe = 'config-only'
      return _storageProbe
    }
    // We can't query through Lucid before the adapter is wired in tests, so
    // go straight to the underlying connection by name.
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const result = await db
      .connection(getConfig().backofficeConnectionName)
      .rawQuery(`SELECT to_regclass(?) AS reg`, [`${getConfig().backofficeSchemaName}.tenant_plans`])
    const rows = (result?.rows ?? result) as Array<{ reg: string | null }>
    // Only LATCH on a definitive answer: a successful probe genuinely tells us
    // whether the table exists.
    _storageProbe = rows[0]?.reg ? 'tenant_plans' : 'config-only'
    return _storageProbe
  } catch {
    // The probe THREW — almost certainly a transient infra failure (pool
    // timeout, a backoffice failover at first read), not "table missing".
    // Do NOT memoize: latching 'config-only' here would permanently disable
    // storage-backed plans for the rest of the process even after the DB
    // recovers (every tenant silently dropped to defaultPlan). Leave the probe
    // unlatched so the next read retries.
    return 'config-only'
  }
}

/** @internal — for tests only */
export function __resetPlanStorageProbe(): void {
  _storageProbe = null
}
