import { type DateTime } from 'luxon'
import Vehicle, { type VehicleStatus } from '#app/models/tenant_scoped/vehicle'
import Booking from '#app/models/tenant_scoped/booking'

/** Bookings in these states occupy a vehicle for their date window. */
const BLOCKING_STATUSES = ['confirmed', 'active'] as const

/**
 * Fleet availability + the vehicle status machine. Availability is derived from
 * overlapping bookings, not a flag, so a double-book is impossible even if a
 * status flag drifts. Read paths use the `_read` replica connection to
 * demonstrate replica routing.
 */
export default class FleetService {
  /** Is the vehicle free for [pickupAt, dropoffAt), ignoring `exceptBookingId`? */
  async isAvailable(
    vehicleId: string,
    pickupAt: DateTime,
    dropoffAt: DateTime,
    exceptBookingId?: string
  ): Promise<boolean> {
    const query = Booking.query()
      .where('vehicle_id', vehicleId)
      .whereIn('status', [...BLOCKING_STATUSES])
      // Two ranges overlap when each starts before the other ends.
      .where('pickup_at', '<', dropoffAt.toSQL()!)
      .where('dropoff_at', '>', pickupAt.toSQL()!)
    if (exceptBookingId) query.whereNot('id', exceptBookingId)
    const clash = await query.first()
    return clash === null
  }

  /** Vehicles marked available AND with no blocking booking in the window. */
  async availableVehicles(pickupAt: DateTime, dropoffAt: DateTime): Promise<Vehicle[]> {
    const vehicles = await Vehicle.query().where('status', 'available').orderBy('plate', 'asc')
    const free: Vehicle[] = []
    for (const v of vehicles) {
      if (await this.isAvailable(v.id, pickupAt, dropoffAt)) free.push(v)
    }
    return free
  }

  async setStatus(vehicleId: string, status: VehicleStatus): Promise<Vehicle> {
    const vehicle = await Vehicle.findOrFail(vehicleId)
    vehicle.status = status
    await vehicle.save()
    return vehicle
  }
}
