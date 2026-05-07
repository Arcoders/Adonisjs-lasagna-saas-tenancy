import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy'
import {
  TenantCreated,
  TenantActivated,
  TenantSuspended,
  TenantBackedUp,
  TenantQuotaExceeded,
  TenantProvisioned,
  TenantMigrated,
  TenantRestored,
  TenantCloned,
  TenantUpdated,
  TenantDeleted,
} from '@adonisjs-lasagna/saas-tenancy/events'
import type { EmitterService } from '@adonisjs/core/types'

/**
 * Append-only audit log of every lifecycle event the package emits. The 11
 * events covered here are exactly those exported by
 * `@adonisjs-lasagna/saas-tenancy/events`. The `/demo/audit` endpoint reads
 * these rows back so the e2e suite can prove the wiring end-to-end.
 *
 * Each `before*` failure is materialised in the package as a thrown error,
 * not an event, so listeners only ever see successful transitions.
 *
 * The emitter is passed in by `AppProvider.boot()` rather than imported as a
 * service singleton — the magic import resolves to `undefined` until the
 * `app.booted()` hook fires, which is *after* provider `boot()` runs.
 */
async function record(
  tenantId: string,
  action: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await new TenantAuditLog()
    .merge({
      tenantId,
      actorType: 'system',
      action,
      metadata: metadata ?? null,
    })
    .save()
}

export default class AuditListener {
  static register(emitter: EmitterService): void {
    emitter.on(TenantCreated, ({ tenant }) =>
      record(tenant.id, 'tenant.created', { name: tenant.name, email: tenant.email })
    )

    emitter.on(TenantActivated, ({ tenant }) => record(tenant.id, 'tenant.activated'))
    emitter.on(TenantSuspended, ({ tenant }) => record(tenant.id, 'tenant.suspended'))
    emitter.on(TenantProvisioned, ({ tenant }) => record(tenant.id, 'tenant.provisioned'))
    emitter.on(TenantDeleted, ({ tenant }) => record(tenant.id, 'tenant.deleted'))

    emitter.on(TenantUpdated, ({ tenant }) =>
      record(tenant.id, 'tenant.updated', { name: tenant.name, email: tenant.email })
    )

    emitter.on(TenantMigrated, ({ tenant, direction }) =>
      record(tenant.id, 'tenant.migrated', { direction })
    )

    emitter.on(TenantBackedUp, ({ tenant, metadata }) =>
      record(tenant.id, 'tenant.backed_up', {
        file: metadata.file,
        sizeBytes: metadata.size,
      })
    )

    emitter.on(TenantRestored, ({ tenant, fileName }) =>
      record(tenant.id, 'tenant.restored', { fileName })
    )

    emitter.on(TenantCloned, ({ source, destination, result }) =>
      // Logged against the destination — that's the new tenant the event
      // materialises.
      record(destination.id, 'tenant.cloned', {
        sourceId: source.id,
        tablesCopied: result.tablesCopied,
        rowsCopied: result.rowsCopied,
      })
    )

    emitter.on(TenantQuotaExceeded, ({ tenant, quota, limit, current, attempted }) =>
      record(tenant.id, 'tenant.quota_exceeded', { quota, limit, current, attempted })
    )
  }
}
