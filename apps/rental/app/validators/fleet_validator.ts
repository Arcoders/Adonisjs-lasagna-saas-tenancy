import vine from '@vinejs/vine'
import type { ExactOptionalProps } from './exact_optional.js'

const createLocationSchema = {
  name: vine.string().trim().minLength(2).maxLength(120),
  type: vine.enum(['airport', 'city', 'depot'] as const).optional(),
  address: vine.string().trim().maxLength(240).optional(),
  city: vine.string().trim().minLength(2).maxLength(120),
  timezone: vine.string().trim().maxLength(60).optional(),
  phone: vine.string().trim().maxLength(40).optional(),
  openHour: vine.number().min(0).max(23).optional(),
  closeHour: vine.number().min(0).max(23).optional(),
}
export const createLocationValidator = vine.compile(
  vine.object(createLocationSchema as ExactOptionalProps<typeof createLocationSchema>)
)

const createCategorySchema = {
  name: vine.string().trim().minLength(2).maxLength(120),
  code: vine.enum(['economy', 'compact', 'suv', 'luxury', 'van'] as const),
  dailyRate: vine.number().min(0),
  depositAmount: vine.number().min(0),
  extras: vine.array(vine.string().trim().maxLength(60)).optional(),
}
export const createCategoryValidator = vine.compile(
  vine.object(createCategorySchema as ExactOptionalProps<typeof createCategorySchema>)
)

const createVehicleSchema = {
  plate: vine.string().trim().minLength(2).maxLength(20),
  makeId: vine.number().positive(),
  modelId: vine.number().positive(),
  year: vine.number().min(1990).max(2100),
  categoryId: vine.string().uuid(),
  locationId: vine.string().uuid().optional(),
  fuel: vine.enum(['petrol', 'diesel', 'hybrid', 'electric'] as const).optional(),
  transmission: vine.enum(['manual', 'automatic'] as const).optional(),
  color: vine.string().trim().maxLength(40).optional(),
  mileage: vine.number().min(0).optional(),
}
export const createVehicleValidator = vine.compile(
  vine.object(createVehicleSchema as ExactOptionalProps<typeof createVehicleSchema>)
)

export const vehicleStatusValidator = vine.compile(
  vine.object({
    status: vine.enum(['available', 'rented', 'maintenance', 'retired'] as const),
  })
)
