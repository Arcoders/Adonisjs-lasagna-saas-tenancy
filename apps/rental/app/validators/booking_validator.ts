import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const createBookingSchema = {
  customerId: vine.string().uuid(),
  vehicleId: vine.string().uuid(),
  // ISO 8601 datetimes; parsed with DateTime.fromISO in the controller.
  pickupAt: vine.string().trim(),
  dropoffAt: vine.string().trim(),
  pickupLocationId: vine.string().uuid().optional(),
  dropoffLocationId: vine.string().uuid().optional(),
  extras: vine.array(vine.string().trim().maxLength(60)).optional(),
  confirm: vine.boolean().optional(),
}
export const createBookingValidator = vine.compile(
  vine.object(createBookingSchema as ExactOptionalProps<typeof createBookingSchema>)
)
