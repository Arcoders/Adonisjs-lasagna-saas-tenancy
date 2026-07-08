import type { ApplicationService } from '@adonisjs/core/types'
import type TenantDataChangedEvent from '../events/tenant_data_changed.js'
import type {
  TenantDataChangePayload,
  TenantDataChangeSubscription,
} from '../events/tenant_data_changed.js'

// Lazy logger so importing this module never triggers `@adonisjs/core`'s
// top-level `await app.booted(...)` outside an Ignitor.
const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/**
 * Wire a plugin's `onDataChange` subscriptions to the {@link TenantDataChanged}
 * event (SEAM-5). Called from the facade's `ready()` (after the emitter is fully
 * constructed). Each subscription becomes a listener that applies the declared
 * model/operation filters and runs `handle` FAIL-OPEN: a throwing or slow
 * subscriber never breaks the write (the emit is already decoupled after-commit),
 * and its failure is logged AND counted on a per-tenant metric — never swallowed.
 *
 * Kept out of `define_plugin.ts` (the E1 no-any surface) so the emitter juggling
 * lives in one place; the facade just resolves the section and hands it here.
 */
export async function subscribeDataChange(
  app: ApplicationService,
  plugin: string,
  subscriptions: readonly TenantDataChangeSubscription[]
): Promise<void> {
  if (subscriptions.length === 0) return
  const emitter = await app.container.make('emitter').catch(() => null)
  if (!emitter) return
  const { default: TenantDataChanged } = await import('../events/tenant_data_changed.js')

  for (const sub of subscriptions) {
    emitter.on(TenantDataChanged, async (event: TenantDataChangedEvent) => {
      const change = event.change
      if (sub.models && !sub.models.includes(change.model)) return
      if (sub.operations && !sub.operations.includes(change.operation)) return
      try {
        await sub.handle(change)
      } catch (error) {
        // silent-catch-ok: delegates to reportSubscriberFailure, which logs the
        // failure and increments the per-tenant metric (fail-open by design).
        await reportSubscriberFailure(plugin, change, error)
      }
    })
  }
}

/** Log + count a subscriber failure. The write already committed and the emit is
 *  decoupled, so this is pure observability — it never rethrows into the emitter. */
async function reportSubscriberFailure(
  plugin: string,
  change: TenantDataChangePayload,
  error: unknown
): Promise<void> {
  const logger = await lazyLogger()
  logger?.error(
    {
      plugin,
      tenantId: change.tenantId,
      model: change.model,
      operation: change.operation,
      err: (error as Error)?.message ?? String(error),
    },
    'onDataChange subscriber failed; continuing (fail-open)'
  )
  try {
    const { default: MetricsService } = await import('./metrics_service.js')
    const { PLUGIN_METRIC } = await import('./observability/plugin_names.js')
    // MetricsService is per-instance stateless (state lives in Redis), so `new` is
    // sanctioned here (see the no_adhoc_stateful_services allowlist).
    await new MetricsService().emitMetric(
      change.tenantId,
      PLUGIN_METRIC.dataChangeSubscriberErrors,
      1
    )
  } catch (metricError) {
    logger?.warn(
      { err: (metricError as Error)?.message ?? String(metricError) },
      'onDataChange failure metric could not be recorded'
    )
  }
}
