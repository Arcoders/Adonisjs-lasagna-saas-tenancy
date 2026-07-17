import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import Booking from '#app/models/tenant_scoped/booking'
import Invoice, { type InvoiceLine } from '#app/models/tenant_scoped/invoice'

/**
 * Issues VAT invoices from a completed/confirmed booking's price breakdown.
 * The invoice number is a per-company yearly sequence (`INV-YYYY-NNNN`); since
 * each company is its own schema, the counter never collides across tenants.
 */
export default class InvoicingService {
  async generateForBooking(bookingId: string): Promise<Invoice> {
    const booking = await Booking.findOrFail(bookingId)
    const existing = await Invoice.query().where('booking_id', booking.id).first()
    if (existing) return existing

    const breakdown = booking.priceBreakdown
    const lines: InvoiceLine[] = []
    if (breakdown) {
      lines.push({
        description: `Rental — ${breakdown.days} day(s)`,
        quantity: breakdown.days,
        unitAmount: breakdown.dailyRate,
        amount: breakdown.base,
      })
      if (breakdown.extras > 0) {
        lines.push({
          description: 'Extras',
          quantity: 1,
          unitAmount: breakdown.extras,
          amount: breakdown.extras,
        })
      }
    }
    const subtotal = breakdown ? breakdown.base + breakdown.extras : booking.totalAmount
    const vat = breakdown ? breakdown.vat : 0

    const invoice = new Invoice()
    invoice.id = randomUUID()
    invoice.bookingId = booking.id
    invoice.number = await this.nextNumber()
    invoice.lines = lines
    invoice.subtotal = subtotal
    invoice.vat = vat
    invoice.total = subtotal + vat
    invoice.currency = booking.currency
    invoice.issuedAt = DateTime.now()
    await invoice.save()
    return invoice
  }

  private async nextNumber(): Promise<string> {
    const year = DateTime.now().year
    const count = await Invoice.query()
      .whereRaw('number like ?', [`INV-${year}-%`])
      .count('* as total')
    const n = Number((count[0]?.$extras as { total?: unknown })?.total ?? 0) + 1
    return `INV-${year}-${String(n).padStart(4, '0')}`
  }
}
