import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { TracksDataChanges } from '@adonisjs-lasagna/saas-tenancy/mixins'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Customer from '#app/models/tenant_scoped/customer'
import Vehicle from '#app/models/tenant_scoped/vehicle'

export type BookingStatus = 'quote' | 'confirmed' | 'active' | 'completed' | 'cancelled' | 'no_show'

export interface PriceBreakdown {
  days: number
  dailyRate: number
  base: number
  extras: number
  vat: number
  total: number
  currency: string
}

/**
 * A rental from pickup to dropoff. `reference` is a short human code
 * (`KRM-XXXXXX`). Money fields are santimat. `priceBreakdown` records how the
 * total was computed so a receipt is reproducible. The status is the booking
 * lifecycle BookingService drives (quote → confirmed → active → completed).
 *
 * Wrapped in `TracksDataChanges` so every committed write emits a PII-free
 * `TenantDataChanged` event; BookingBoardListener forwards it to the company's
 * live socket room so the reservations board updates in real time.
 */
export default class Booking extends TracksDataChanges(TenantBaseModel) {
  static table = 'bookings'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare reference: string

  @column()
  declare customerId: string

  @column()
  declare vehicleId: string

  @column()
  declare pickupLocationId: string | null

  @column.dateTime()
  declare pickupAt: DateTime

  @column()
  declare dropoffLocationId: string | null

  @column.dateTime()
  declare dropoffAt: DateTime

  @column()
  declare status: BookingStatus

  @column({
    prepare: (value: PriceBreakdown | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | PriceBreakdown | null) =>
      typeof value === 'string' ? (JSON.parse(value) as PriceBreakdown) : value,
  })
  declare priceBreakdown: PriceBreakdown | null

  @column()
  declare depositHeld: number

  @column({
    prepare: (value: string[] | null) => (value ? JSON.stringify(value) : '[]'),
    consume: (value: string | string[] | null) =>
      typeof value === 'string' ? (JSON.parse(value) as string[]) : (value ?? []),
  })
  declare extras: string[]

  @column()
  declare totalAmount: number

  @column()
  declare currency: string

  @belongsTo(() => Customer, { foreignKey: 'customerId' })
  declare customer: BelongsTo<typeof Customer>

  @belongsTo(() => Vehicle, { foreignKey: 'vehicleId' })
  declare vehicle: BelongsTo<typeof Vehicle>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
