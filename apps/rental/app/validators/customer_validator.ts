import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const createCustomerSchema = {
  fullName: vine.string().trim().minLength(2).maxLength(160),
  email: vine.string().trim().email().optional(),
  phone: vine.string().trim().maxLength(40).optional(),
  cin: vine.string().trim().maxLength(40).optional(),
  driverLicense: vine.string().trim().maxLength(40).optional(),
  passport: vine.string().trim().maxLength(40).optional(),
  address: vine.string().trim().maxLength(240).optional(),
  dateOfBirth: vine.string().trim().maxLength(40).optional(),
  nationality: vine.string().trim().maxLength(60).optional(),
}
export const createCustomerValidator = vine.compile(
  vine.object(createCustomerSchema as ExactOptionalProps<typeof createCustomerSchema>)
)

export const searchCustomerValidator = vine.compile(
  vine.object({ cin: vine.string().trim().minLength(1).maxLength(40) })
)
