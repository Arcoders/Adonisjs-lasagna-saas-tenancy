import { inject } from '@adonisjs/core'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import { EncryptedRepository } from '@adonisjs-lasagna/crypto'
import Customer from '#app/models/tenant_scoped/customer'

/** Matches the category on Customer's encrypted fields. */
const CATEGORY = 'renter-id'

export interface CreateCustomerInput {
  fullName: string
  email?: string | null | undefined
  phone?: string | null | undefined
  cin?: string | null | undefined
  driverLicense?: string | null | undefined
  passport?: string | null | undefined
  address?: string | null | undefined
  dateOfBirth?: string | null | undefined
  nationality?: string | null | undefined
}

/**
 * Renter records with crypto-protected PII. Writes go through the model
 * instance so the `@encrypted`/`@searchable` hooks encrypt + index transparently
 * (a raw write would be rejected by the DB CHECK). CIN search resolves the
 * plaintext to its blind index first, so equality lookup never decrypts and
 * still works after a shred. A shred destroys the renter's DEK, making every
 * identity field unreadable at once.
 */
@inject()
export default class CustomerService {
  constructor(private readonly crypto: EncryptedRepository) {}

  /**
   * The list view. Shows masked PII (data minimisation) and, critically, must
   * survive shredded renters: their DEK is gone, so the model's decrypt hook
   * would throw `dek_missing` and 500 the whole list the moment one renter has
   * exercised erasure. We read only the plaintext columns as POJOs (no model
   * hydration → no decrypt hook, and the encrypted CIN / licence / passport
   * ciphertext is never even selected). Full identity fields are decrypted only
   * on the detail view, which fails closed to 410 once shredded.
   */
  async list(): Promise<Record<string, unknown>[]> {
    const rows = await Customer.query()
      .select(
        'id',
        'full_name',
        'email',
        'phone',
        'address',
        'nationality',
        'date_of_birth',
        'created_at'
      )
      .orderBy('created_at', 'desc')
      .pojo<{
        id: string
        full_name: string
        email: string | null
        phone: string | null
        address: string | null
        nationality: string | null
        date_of_birth: string | null
        created_at: string
      }>()

    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      address: r.address,
      nationality: r.nationality,
      dateOfBirth: r.date_of_birth,
      createdAt: r.created_at,
      // Encrypted identity fields are surfaced only on the detail view.
      cin: null,
      driverLicense: null,
      passport: null,
    }))
  }

  find(id: string) {
    return Customer.find(id)
  }

  async create(input: CreateCustomerInput): Promise<Customer> {
    const customer = new Customer()
    customer.id = randomUUID()
    customer.fullName = input.fullName
    customer.email = input.email ?? null
    customer.phone = input.phone ?? null
    customer.cin = input.cin ?? null
    customer.driverLicense = input.driverLicense ?? null
    customer.passport = input.passport ?? null
    customer.address = input.address ?? null
    customer.dateOfBirth = input.dateOfBirth ? DateTime.fromISO(input.dateOfBirth) : null
    customer.nationality = input.nationality ?? 'MA'
    await customer.save()
    return customer
  }

  /** Equality search by CIN via the keyed-HMAC blind index (never decrypts). */
  async searchByCin(cin: string): Promise<Customer[]> {
    const index = await this.crypto.blindIndex(CATEGORY, cin)
    return Customer.query().where('cin_index', index)
  }

  /**
   * Crypto-shred a renter's DEK (gated by the erasabilityResolver + WORM
   * ledger). Afterwards every identity field is irrecoverable; the index
   * columns are nulled through a hook-free write so the equality/frequency leak
   * is closed too.
   */
  async shred(customerId: string) {
    const result = await this.crypto.shred(customerId, CATEGORY)
    await Customer.query()
      .where('id', customerId)
      .update({ cin_index: null, driver_license_index: null, passport_index: null })
    return result
  }
}
