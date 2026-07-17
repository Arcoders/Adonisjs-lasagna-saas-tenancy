import { inject } from '@adonisjs/core'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import Booking, { type BookingStatus } from '#app/models/tenant_scoped/booking'
import Vehicle from '#app/models/tenant_scoped/vehicle'
import Customer from '#app/models/tenant_scoped/customer'
import VehicleCategory from '#app/models/tenant_scoped/vehicle_category'
import FleetService from '#app/services/fleet_service'
import PricingService from '#app/services/pricing_service'

export class BookingError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface CreateBookingInput {
  customerId: string
  vehicleId: string
  pickupAt: DateTime
  dropoffAt: DateTime
  pickupLocationId?: string | null
  dropoffLocationId?: string | null
  extras?: string[]
  confirm?: boolean
}

/** `KRM-A1B2C3` */
function bookingReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = randomUUID().replace(/-/g, '')
  for (let i = 0; i < 6; i++) code += alphabet[Number.parseInt(bytes[i]!, 16) % alphabet.length]
  return `KRM-${code}`
}

/**
 * The heart of the domain. Creating a booking validates the vehicle is free for
 * the window (no double-book), prices it, and persists the breakdown.
 *
 * The satellite phase layers on: `enforceQuota('bookingsPerMonth')`, a
 * `TenantDataChanged` emit (→ live dashboard over websockets + metrics), and a
 * `booking.created` webhook. The pure domain rules live here.
 */
@inject()
export default class BookingService {
  constructor(
    private readonly fleet: FleetService,
    private readonly pricing: PricingService
  ) {}

  async create(input: CreateBookingInput): Promise<Booking> {
    if (input.dropoffAt <= input.pickupAt) {
      throw new BookingError('invalid_dates', 'Dropoff must be after pickup.')
    }

    const customer = await Customer.find(input.customerId)
    if (!customer) throw new BookingError('customer_not_found', 'Customer does not exist.')

    const vehicle = await Vehicle.find(input.vehicleId)
    if (!vehicle) throw new BookingError('vehicle_not_found', 'Vehicle does not exist.')
    if (vehicle.status === 'retired' || vehicle.status === 'maintenance') {
      throw new BookingError('vehicle_unavailable', `Vehicle is ${vehicle.status}.`)
    }

    const free = await this.fleet.isAvailable(vehicle.id, input.pickupAt, input.dropoffAt)
    if (!free) throw new BookingError('overlap', 'Vehicle is already booked for that window.')

    const category = await VehicleCategory.findOrFail(vehicle.categoryId)
    const breakdown = this.pricing.quote(
      category,
      input.pickupAt,
      input.dropoffAt,
      input.extras ?? []
    )

    const booking = new Booking()
    booking.id = randomUUID()
    booking.reference = bookingReference()
    booking.customerId = customer.id
    booking.vehicleId = vehicle.id
    booking.pickupLocationId = input.pickupLocationId ?? vehicle.locationId ?? null
    booking.pickupAt = input.pickupAt
    booking.dropoffLocationId = input.dropoffLocationId ?? vehicle.locationId ?? null
    booking.dropoffAt = input.dropoffAt
    booking.status = input.confirm ? 'confirmed' : 'quote'
    booking.priceBreakdown = breakdown
    booking.depositHeld = input.confirm ? category.depositAmount : 0
    booking.extras = input.extras ?? []
    booking.totalAmount = breakdown.total
    booking.currency = breakdown.currency
    await booking.save()
    return booking
  }

  /** quote → confirmed: hold the deposit. */
  async confirm(id: string): Promise<Booking> {
    const booking = await Booking.findOrFail(id)
    this.assertTransition(booking.status, 'confirmed', ['quote'])
    const vehicle = await Vehicle.findOrFail(booking.vehicleId)
    const category = await VehicleCategory.findOrFail(vehicle.categoryId)
    booking.status = 'confirmed'
    booking.depositHeld = category.depositAmount
    await booking.save()
    return booking
  }

  /** confirmed → active: hand the keys over, mark the vehicle rented. */
  async activate(id: string): Promise<Booking> {
    const booking = await Booking.findOrFail(id)
    this.assertTransition(booking.status, 'active', ['confirmed'])
    booking.status = 'active'
    await booking.save()
    await this.fleet.setStatus(booking.vehicleId, 'rented')
    return booking
  }

  /** active → completed: take the vehicle back, free it. */
  async complete(id: string): Promise<Booking> {
    const booking = await Booking.findOrFail(id)
    this.assertTransition(booking.status, 'completed', ['active'])
    booking.status = 'completed'
    await booking.save()
    await this.fleet.setStatus(booking.vehicleId, 'available')
    return booking
  }

  async cancel(id: string): Promise<Booking> {
    const booking = await Booking.findOrFail(id)
    this.assertTransition(booking.status, 'cancelled', ['quote', 'confirmed'])
    booking.status = 'cancelled'
    await booking.save()
    return booking
  }

  private assertTransition(from: BookingStatus, to: BookingStatus, allowedFrom: BookingStatus[]) {
    if (!allowedFrom.includes(from)) {
      throw new BookingError('invalid_transition', `Cannot move a ${from} booking to ${to}.`)
    }
  }
}
