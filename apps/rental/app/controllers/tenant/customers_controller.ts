import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { CryptoException } from '@adonisjs-lasagna/crypto'
import CustomerService from '#app/services/customer_service'
import {
  createCustomerValidator,
  searchCustomerValidator,
} from '#app/validators/customer_validator'

/**
 * Renter management over crypto-protected PII. Reading a shredded renter fails
 * closed (410 Gone) rather than surfacing inert ciphertext; the "exercise
 * erasure right" button calls `shred`. Refused shreds (governance said the
 * category is not erasable) come back as 403.
 */
@inject()
export default class CustomersController {
  constructor(private readonly customers: CustomerService) {}

  async list({ response }: HttpContext) {
    return response.ok({ customers: await this.customers.list() })
  }

  async create({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createCustomerValidator)
    const customer = await this.customers.create(payload)
    return response.created({ customer })
  }

  async show({ params, response }: HttpContext) {
    try {
      const customer = await this.customers.find(params.id)
      if (!customer) return response.notFound({ error: { code: 'not_found' } })
      return response.ok({ customer })
    } catch (error) {
      if (error instanceof CryptoException) {
        return response.status(410).send({ error: { code: 'unrecoverable', detail: error.code } })
      }
      throw error
    }
  }

  async search({ request, response }: HttpContext) {
    const { cin } = await request.validateUsing(searchCustomerValidator)
    const matches = await this.customers.searchByCin(cin)
    return response.ok({ matches })
  }

  /** Exercise a renter's erasure right (Law 09-08 Art. equivalent): crypto-shred. */
  async shred({ params, response }: HttpContext) {
    try {
      const result = await this.customers.shred(params.id)
      return response.ok(result)
    } catch (error) {
      if (error instanceof CryptoException && error.code === 'shred_refused') {
        return response
          .status(403)
          .send({ error: { code: 'shred_refused', message: error.message } })
      }
      throw error
    }
  }
}
