import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { DateTime } from 'luxon'
import Booking from '#app/models/tenant_scoped/booking'
import BookingService, { BookingError } from '#app/services/booking_service'
import InvoicingService from '#app/services/invoicing_service'
import { createBookingValidator } from '#app/validators/booking_validator'

/**
 * The booking lifecycle surface. Creation runs the overlap check + pricing in
 * BookingService; the transition endpoints drive quote → confirmed → active →
 * completed and flip the vehicle's status as a side effect. In the satellite
 * phase, `create` also emits `TenantDataChanged` (live board) and fires the
 * `booking.created` webhook, and gains an `enforceQuota('bookingsPerMonth')`
 * gate on its route.
 */
@inject()
export default class BookingsController {
  constructor(
    private readonly bookings: BookingService,
    private readonly invoicing: InvoicingService
  ) {}

  async list({ response }: HttpContext) {
    const rows = await Booking.query()
      .orderBy('created_at', 'desc')
      .preload('customer')
      .preload('vehicle')
    return response.ok({ bookings: rows })
  }

  async show({ params, response }: HttpContext) {
    const booking = await Booking.query()
      .where('id', params.id)
      .preload('customer')
      .preload('vehicle')
      .first()
    if (!booking) return response.notFound({ error: { code: 'not_found' } })
    return response.ok({ booking })
  }

  async create({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createBookingValidator)
    const pickupAt = DateTime.fromISO(payload.pickupAt)
    const dropoffAt = DateTime.fromISO(payload.dropoffAt)
    if (!pickupAt.isValid || !dropoffAt.isValid) {
      return response.badRequest({
        error: { code: 'invalid_dates', message: 'pickupAt/dropoffAt must be ISO 8601.' },
      })
    }
    try {
      const booking = await this.bookings.create({
        customerId: payload.customerId,
        vehicleId: payload.vehicleId,
        pickupAt,
        dropoffAt,
        pickupLocationId: payload.pickupLocationId ?? null,
        dropoffLocationId: payload.dropoffLocationId ?? null,
        extras: payload.extras ?? [],
        confirm: payload.confirm ?? false,
      })
      return response.created({ booking })
    } catch (error) {
      if (error instanceof BookingError) {
        return response.unprocessableEntity({ error: { code: error.code, message: error.message } })
      }
      throw error
    }
  }

  async confirm(ctx: HttpContext) {
    return this.transition(ctx, (id) => this.bookings.confirm(id))
  }
  async activate(ctx: HttpContext) {
    return this.transition(ctx, (id) => this.bookings.activate(id))
  }
  async complete(ctx: HttpContext) {
    return this.transition(ctx, (id) => this.bookings.complete(id))
  }
  async cancel(ctx: HttpContext) {
    return this.transition(ctx, (id) => this.bookings.cancel(id))
  }

  /** Issue (or return the existing) VAT invoice for a booking. */
  async invoice({ params, response }: HttpContext) {
    const invoice = await this.invoicing.generateForBooking(params.id)
    return response.ok({ invoice })
  }

  private async transition(
    { params, response }: HttpContext,
    run: (id: string) => Promise<Booking>
  ) {
    try {
      const booking = await run(params.id)
      return response.ok({ id: booking.id, status: booking.status })
    } catch (error) {
      if (error instanceof BookingError) {
        return response.unprocessableEntity({ error: { code: error.code, message: error.message } })
      }
      throw error
    }
  }
}
