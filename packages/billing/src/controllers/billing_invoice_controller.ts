import type { HttpContext } from '@adonisjs/core/http'
import BillingInvoiceSnapshot from '../models/satellites/billing_invoice_snapshot.js'

/**
 * `request.tenant()` is a macro the core provider installs on the host's
 * HttpRequest at runtime. Billing's own compilation doesn't load that
 * augmentation, so we resolve it through a minimal typed view rather than depend
 * on a side-effecting import.
 */
interface TenantResolvableRequest {
  tenant(): Promise<{ id: string }>
}

/**
 * Read-through invoice endpoints over the fiscal `billing_invoice_snapshots`
 * read model (fiscal opt-in). The provider stays the system of record; this only
 * serves the snapshots we recorded plus a redirect to the provider-hosted PDF.
 *
 * The host mounts these inside its own auth + tenant middleware group (exactly
 * like checkout / portal), so access control stays with the host. The package
 * never registers unauthenticated tenant-data routes. Both actions scope every
 * query to `request.tenant()`, so one tenant can't read another's invoices.
 *
 * ```ts
 * // start/routes.ts — behind your auth + activeTenant stack
 * import { BillingInvoiceController } from '@adonisjs-lasagna/billing'
 * router.group(() => {
 *   router.get('/billing/invoices', (ctx) => new BillingInvoiceController().index(ctx))
 *   router.get('/billing/invoices/:id/pdf', (ctx) => new BillingInvoiceController().pdf(ctx))
 * }).use([middleware.auth(), middleware.activeTenant()])
 * ```
 */
export default class BillingInvoiceController {
  async index(ctx: HttpContext) {
    const tenant = await (ctx.request as unknown as TenantResolvableRequest).tenant()
    const rows = await BillingInvoiceSnapshot.query()
      .where('tenantId', tenant.id)
      .orderBy('issuedAt', 'desc')
      .limit(100)

    return ctx.response.json({
      invoices: rows.map((r) => ({
        id: r.providerInvoiceId,
        currency: r.currency,
        subtotal: r.subtotalCents,
        tax: r.taxCents,
        total: r.totalCents,
        status: r.status,
        pdfUrl: r.pdfUrl,
        issuedAt: r.issuedAt?.toISO() ?? null,
      })),
    })
  }

  async pdf(ctx: HttpContext) {
    const tenant = await (ctx.request as unknown as TenantResolvableRequest).tenant()
    const row = await BillingInvoiceSnapshot.query()
      .where('tenantId', tenant.id)
      .where('providerInvoiceId', ctx.params.id)
      .first()

    if (!row?.pdfUrl) {
      return ctx.response.notFound({ error: 'invoice pdf not available' })
    }
    // Read-through: redirect to the provider-hosted PDF rather than proxying bytes.
    return ctx.response.redirect(row.pdfUrl)
  }
}
