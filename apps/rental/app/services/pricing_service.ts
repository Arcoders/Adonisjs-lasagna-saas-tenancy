import { type DateTime } from 'luxon'
import type VehicleCategory from '#app/models/tenant_scoped/vehicle_category'
import type { PriceBreakdown } from '#app/models/tenant_scoped/booking'

/** Moroccan TVA. */
const VAT_RATE = 0.2
/** Flat per-extra, per-day charge in santimat (50 MAD/day). */
const EXTRA_DAILY_SANTIMAT = 5_000

/**
 * Turns a category + date range + extras into a reproducible price breakdown.
 * All amounts are integer santimat. Kept pure (no DB) so it is trivial to test
 * and the same call powers a quote and the final invoice.
 */
export default class PricingService {
  /** Whole rental days, minimum one, rounding a partial day up. */
  rentalDays(pickupAt: DateTime, dropoffAt: DateTime): number {
    const hours = dropoffAt.diff(pickupAt, 'hours').hours
    return Math.max(1, Math.ceil(hours / 24))
  }

  quote(
    category: VehicleCategory,
    pickupAt: DateTime,
    dropoffAt: DateTime,
    extras: string[] = []
  ): PriceBreakdown {
    const days = this.rentalDays(pickupAt, dropoffAt)
    const base = days * category.dailyRate
    const extrasTotal = extras.length * EXTRA_DAILY_SANTIMAT * days
    const subtotal = base + extrasTotal
    const vat = Math.round(subtotal * VAT_RATE)
    return {
      days,
      dailyRate: category.dailyRate,
      base,
      extras: extrasTotal,
      vat,
      total: subtotal + vat,
      currency: 'MAD',
    }
  }
}
