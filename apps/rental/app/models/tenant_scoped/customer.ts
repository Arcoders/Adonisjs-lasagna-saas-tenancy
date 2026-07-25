import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'
import { encrypted, searchable, withEncryptedFields } from '@adonisjs-lasagna/crypto'

/** All three identity documents share one per-renter DEK, so a single shred
 * erases the renter's whole identity set at once. */
const CATEGORY = 'renter-id'

/**
 * A renter. Tenant-scoped, so a person who rents from two companies is two
 * independent rows in two schemas.
 *
 * The identity fields — `cin` (Moroccan national ID), `driverLicense`,
 * `passport` — are PII under Law 09-08 / the CNDP, stored as crypto
 * `@encrypted` fields (enc_v2 ciphertext at rest, plaintext in memory) keyed by
 * the `(customer.id × renter-id)` DEK. Each has a `@searchable` blind-index
 * sibling for equality lookup that survives a shred. Crypto-shredding the DEK
 * makes all three fields unreadable at once (re-reading fails closed → 410),
 * which is how a renter's erasure right is honoured irreversibly.
 */
export default class Customer extends compose(TenantBaseModel, withEncryptedFields) {
  static table = 'customers'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare fullName: string

  @column()
  declare email: string | null

  @column()
  declare phone: string | null

  // ─── Encrypted PII (per-renter DEK) ──────────────────────────────
  @encrypted({ category: CATEGORY, subject: (row: Customer) => row.id })
  declare cin: string | null

  @encrypted({ category: CATEGORY, subject: (row: Customer) => row.id })
  declare driverLicense: string | null

  @encrypted({ category: CATEGORY, subject: (row: Customer) => row.id })
  declare passport: string | null

  // ─── Blind indexes (keyed-HMAC, survive a shred) ─────────────────
  @searchable({ category: CATEGORY, from: (row: Customer) => row.cin })
  declare cinIndex: string | null

  @searchable({ category: CATEGORY, from: (row: Customer) => row.driverLicense })
  declare driverLicenseIndex: string | null

  @searchable({ category: CATEGORY, from: (row: Customer) => row.passport })
  declare passportIndex: string | null

  @column()
  declare address: string | null

  @column.date()
  declare dateOfBirth: DateTime | null

  @column()
  declare nationality: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
