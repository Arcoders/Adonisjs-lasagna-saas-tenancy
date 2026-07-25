import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import RentalLocation from '#app/models/tenant_scoped/rental_location'
import VehicleCategory from '#app/models/tenant_scoped/vehicle_category'
import Vehicle from '#app/models/tenant_scoped/vehicle'
import CarMake from '#app/models/central/car_make'
import CarModel from '#app/models/central/car_model'
import FleetService from '#app/services/fleet_service'
import { currentTenant } from '#app/helpers/current_tenant'
import {
  createLocationValidator,
  createCategoryValidator,
  createVehicleValidator,
  vehicleStatusValidator,
} from '#app/validators/fleet_validator'

/**
 * The company's fleet surface: branches, categories and vehicles. Vehicle
 * listing reads through the `_read` replica connection; the make/model come
 * from the shared central catalog. Vehicle creation resolves the catalog names
 * so a listing renders without crossing the connection.
 */
@inject()
export default class FleetController {
  constructor(private readonly fleet: FleetService) {}

  /** The shared central catalog (make → models) a company picks vehicles from. */
  async catalog({ response }: HttpContext) {
    const makes = await CarMake.query().preload('models').orderBy('name')
    return response.ok({
      makes: makes.map((m) => ({
        id: m.id,
        name: m.name,
        models: m.models.map((mo) => ({ id: mo.id, name: mo.name, bodyType: mo.bodyType })),
      })),
    })
  }

  // ─── Locations ───────────────────────────────────────────────────
  async listLocations({ response }: HttpContext) {
    return response.ok({ locations: await RentalLocation.query().orderBy('name') })
  }

  async createLocation({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createLocationValidator)
    const location = await RentalLocation.create({
      id: randomUUID(),
      name: payload.name,
      type: payload.type ?? 'city',
      address: payload.address ?? null,
      city: payload.city,
      timezone: payload.timezone ?? 'Africa/Casablanca',
      phone: payload.phone ?? null,
      openHour: payload.openHour ?? 8,
      closeHour: payload.closeHour ?? 20,
    })
    return response.created({ location })
  }

  // ─── Categories ──────────────────────────────────────────────────
  async listCategories({ response }: HttpContext) {
    return response.ok({ categories: await VehicleCategory.query().orderBy('daily_rate') })
  }

  async createCategory({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createCategoryValidator)
    const category = await VehicleCategory.create({
      id: randomUUID(),
      ...payload,
      extras: payload.extras ?? [],
    })
    return response.created({ category })
  }

  // ─── Vehicles ────────────────────────────────────────────────────
  async listVehicles({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    // Route the listing read to the `_read` replica connection to exercise
    // replica routing (falls back to the primary when none is configured).
    const read = await tenant.getReadConnection()
    const rows = await read.from('vehicles').select('*').orderBy('plate')
    return response.ok({ vehicles: rows })
  }

  async createVehicle({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createVehicleValidator)
    const model = await CarModel.query().where('id', payload.modelId).preload('make').first()
    if (!model || model.makeId !== payload.makeId) {
      return response.unprocessableEntity({
        error: { code: 'catalog_mismatch', message: 'Unknown make/model.' },
      })
    }
    const vehicle = await Vehicle.create({
      id: randomUUID(),
      plate: payload.plate,
      makeId: payload.makeId,
      modelId: payload.modelId,
      makeName: model.make.name,
      modelName: model.name,
      year: payload.year,
      categoryId: payload.categoryId,
      locationId: payload.locationId ?? null,
      status: 'available',
      mileage: payload.mileage ?? 0,
      fuel: payload.fuel ?? 'petrol',
      transmission: payload.transmission ?? 'manual',
      color: payload.color ?? null,
    })
    return response.created({ vehicle })
  }

  async showVehicle({ params, response }: HttpContext) {
    const vehicle = await Vehicle.query()
      .where('id', params.id)
      .preload('category')
      .preload('location')
      .first()
    if (!vehicle) return response.notFound({ error: { code: 'not_found' } })
    return response.ok({ vehicle })
  }

  async setVehicleStatus({ params, request, response }: HttpContext) {
    const { status } = await request.validateUsing(vehicleStatusValidator)
    const vehicle = await this.fleet.setStatus(params.id, status)
    return response.ok({ id: vehicle.id, status: vehicle.status })
  }

  async availability({ request, response }: HttpContext) {
    const pickup = DateTime.fromISO(String(request.qs().pickupAt ?? ''))
    const dropoff = DateTime.fromISO(String(request.qs().dropoffAt ?? ''))
    if (!pickup.isValid || !dropoff.isValid) {
      return response.badRequest({
        error: { code: 'invalid_dates', message: 'pickupAt/dropoffAt must be ISO 8601.' },
      })
    }
    const vehicles = await this.fleet.availableVehicles(pickup, dropoff)
    return response.ok({
      available: vehicles.map((v) => ({
        id: v.id,
        plate: v.plate,
        makeName: v.makeName,
        modelName: v.modelName,
      })),
    })
  }
}
