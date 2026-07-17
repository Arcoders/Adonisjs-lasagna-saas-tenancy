import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { randomUUID, createHash } from 'node:crypto'
import { DateTime } from 'luxon'
// Type-only: erased at compile, so it is safe at command-discovery time (no
// runtime import of the model before the app has booted).
import type Tenant from '#app/models/backoffice/tenant'

/**
 * Fills each provisioned demo company with a believable working dataset:
 * branches, a rate card, a fleet drawn from the shared catalog, renters with
 * encrypted PII, bookings spread across the lifecycle (with invoices and
 * payments for the completed ones), and a small RAG corpus of policy docs whose
 * bodies are embedded into the tenant vector store.
 *
 * This is the data-plane companion to `rental:seed`. That command creates the
 * company rows and dispatches provisioning; the schemas only exist once the
 * queue worker has run InstallTenant and `migration:tenant:run` has migrated
 * them. So this seed runs as a SEPARATE, later pass over the already-migrated
 * companies. It is fully idempotent: every row is keyed on a natural identifier
 * (location name, category code, plate, renter email, doc source), bookings are
 * seeded only when a company has none yet, and the embedding insert dedups on
 * `(source, content_hash)`. Re-running tops up anything missing and never
 * duplicates.
 *
 * Refuses to run in production (it writes well-known demo data).
 */
export default class RentalSeedDemo extends BaseCommand {
  static readonly commandName = 'rental:seed:demo'
  static readonly description =
    'Fill the provisioned demo companies with fleet, renters, bookings and a RAG corpus'
  static readonly options: CommandOptions = { startApp: true }

  async run() {
    if (this.app.inProduction) {
      this.logger.error('rental:seed:demo writes demo data and refuses to run in production.')
      this.exitCode = 1
      return
    }

    const { default: Tenant } = await import('#app/models/backoffice/tenant')

    // Addressable, live companies only: a company with no vanity host (e.g. one
    // created ad hoc from the operator console) has no staff console to browse
    // the data from, so there is nothing to demo there.
    const companies = await Tenant.query()
      .where('status', 'active')
      .whereNotNull('custom_domain')
      .orderBy('created_at')

    if (companies.length === 0) {
      this.logger.warning(
        'No addressable active companies found. Run `rental:seed`, then the queue worker ' +
          'and `migration:tenant:run`, before seeding demo data.'
      )
      return
    }

    let seeded = 0
    for (const company of companies) {
      try {
        await this.#seedCompany(company)
        seeded++
      } catch (error) {
        // One company failing (e.g. a schema not migrated yet) must not abort the
        // rest of the fleet — surface it and move on.
        this.logger.error(
          `Failed to seed ${company.name} (${company.customDomain}): ${(error as Error).message}`
        )
      }
    }
    this.logger.success(`Demo data ready for ${seeded}/${companies.length} companies.`)
  }

  /** Seed one company's schema. Runs inside its tenancy scope so every tenant
   *  model + the vector-store insert land in `tenant_<id>`. */
  async #seedCompany(company: Tenant) {
    const { tenancy } = await import('@adonisjs-lasagna/saas-tenancy')
    const plan = company.metadata?.plan ?? 'starter'
    const profile = plan === 'starter' ? PROFILES.starter : PROFILES.full

    await tenancy.run(company, async () => {
      const locations = await this.#seedLocations(profile)
      const categories = await this.#seedCategories()
      const vehicles = await this.#seedVehicles(profile, categories, locations)
      const customers = await this.#seedCustomers(profile)
      await this.#seedBookings(vehicles, customers)
      const embedded = await this.#seedKnowledge(company)
      this.logger.info(
        `  ${company.name}: ${locations.length} branches, ${vehicles.length} vehicles, ` +
          `${customers.length} renters, ${embedded} policy docs embedded.`
      )
    })
  }

  // ─── Branches ────────────────────────────────────────────────────
  async #seedLocations(profile: SeedProfile) {
    const { default: RentalLocation } = await import('#app/models/tenant_scoped/rental_location')
    const out: InstanceType<typeof RentalLocation>[] = []
    for (const spec of profile.locations) {
      let loc = await RentalLocation.query().where('name', spec.name).first()
      if (!loc) {
        loc = await RentalLocation.create({
          id: randomUUID(),
          name: spec.name,
          type: spec.type,
          address: spec.address,
          city: spec.city,
          timezone: 'Africa/Casablanca',
          phone: spec.phone ?? null,
          openHour: spec.openHour ?? 8,
          closeHour: spec.closeHour ?? 20,
        })
      }
      out.push(loc)
    }
    return out
  }

  // ─── Rate card ───────────────────────────────────────────────────
  // Returns a code → category-id lookup (that is all the fleet seed needs).
  async #seedCategories(): Promise<Map<string, string>> {
    const { default: VehicleCategory } = await import('#app/models/tenant_scoped/vehicle_category')
    const byCode = new Map<string, string>()
    for (const spec of CATEGORIES) {
      let cat = await VehicleCategory.query().where('code', spec.code).first()
      if (!cat) {
        cat = await VehicleCategory.create({
          id: randomUUID(),
          name: spec.name,
          code: spec.code,
          dailyRate: spec.dailyRate,
          depositAmount: spec.depositAmount,
          extras: spec.extras,
        })
      }
      byCode.set(spec.code, cat.id)
    }
    return byCode
  }

  // ─── Fleet ───────────────────────────────────────────────────────
  async #seedVehicles(
    profile: SeedProfile,
    categories: Map<string, string>,
    locations: { id: string }[]
  ) {
    const { default: Vehicle } = await import('#app/models/tenant_scoped/vehicle')
    const { default: CarModel } = await import('#app/models/central/car_model')

    // Resolve the shared catalog once: (makeSlug::modelName) → { makeId, modelId, makeName, modelName }.
    const models = await CarModel.query().preload('make')
    const catalog = new Map<
      string,
      { makeId: number; modelId: number; makeName: string; modelName: string }
    >()
    for (const m of models) {
      catalog.set(`${m.make.slug}::${m.name}`, {
        makeId: m.makeId,
        modelId: m.id,
        makeName: m.make.name,
        modelName: m.name,
      })
    }

    const out: InstanceType<typeof Vehicle>[] = []
    for (const spec of profile.vehicles) {
      let vehicle = await Vehicle.query().where('plate', spec.plate).first()
      if (!vehicle) {
        const ref = catalog.get(`${spec.makeSlug}::${spec.modelName}`)
        if (!ref) {
          this.logger.warning(
            `  skipping ${spec.plate}: catalog has no ${spec.makeSlug} ${spec.modelName}`
          )
          continue
        }
        const categoryId = categories.get(spec.categoryCode)
        if (!categoryId) continue
        const location = locations[spec.locationIndex % locations.length]
        vehicle = await Vehicle.create({
          id: randomUUID(),
          plate: spec.plate,
          makeId: ref.makeId,
          modelId: ref.modelId,
          makeName: ref.makeName,
          modelName: ref.modelName,
          year: spec.year,
          categoryId,
          locationId: location?.id ?? null,
          status: 'available',
          mileage: spec.mileage,
          fuel: spec.fuel,
          transmission: spec.transmission,
          color: spec.color,
        })
      }
      out.push(vehicle)
    }
    return out
  }

  // ─── Renters (encrypted PII) ─────────────────────────────────────
  async #seedCustomers(profile: SeedProfile) {
    const { default: Customer } = await import('#app/models/tenant_scoped/customer')

    const out: InstanceType<typeof Customer>[] = []
    for (const spec of profile.customers) {
      let customer = await Customer.query().where('email', spec.email).first()
      if (!customer) {
        // Set the identity fields on the model instance and save, exactly as
        // CustomerService.create does: the `@encrypted`/`@searchable` hooks encrypt
        // cin/driverLicense/passport and write their blind indexes transparently (a
        // raw insert of plaintext is rejected by the DB CHECK). We build the model
        // directly rather than resolving CustomerService, whose EncryptedRepository
        // dependency is not constructable outside an HTTP request; the encryption is
        // the model's job either way.
        customer = new Customer()
        customer.id = randomUUID()
        customer.fullName = spec.fullName
        customer.email = spec.email
        customer.phone = spec.phone
        customer.cin = spec.cin ?? null
        customer.driverLicense = spec.driverLicense ?? null
        customer.passport = spec.passport ?? null
        customer.address = spec.address
        customer.dateOfBirth = DateTime.fromISO(spec.dateOfBirth)
        customer.nationality = spec.nationality
        await customer.save()
      }
      out.push(customer)
    }
    return out
  }

  // ─── Bookings + invoices + payments ──────────────────────────────
  async #seedBookings(vehicles: { id: string }[], customers: { id: string }[]) {
    const { default: Booking } = await import('#app/models/tenant_scoped/booking')
    const { default: Payment } = await import('#app/models/tenant_scoped/payment')
    const { default: BookingService } = await import('#app/services/booking_service')
    const { default: FleetService } = await import('#app/services/fleet_service')
    const { default: PricingService } = await import('#app/services/pricing_service')
    const { default: InvoicingService } = await import('#app/services/invoicing_service')

    // Bookings have no stable natural key, so seed them only once per company.
    const existing = await Booking.query().limit(1)
    if (existing.length > 0) return
    if (vehicles.length < 4 || customers.length < 3) return

    // Construct BookingService with its (dependency-free) collaborators directly.
    // Container resolution of @inject classes relies on decorator metadata that
    // esbuild (tsx) does not emit, so it fails in this command context; the HTTP
    // server uses a metadata-emitting loader and is unaffected.
    const bookings = new BookingService(new FleetService(), new PricingService())
    const invoicing = new InvoicingService()
    const now = DateTime.now()

    // A completed rental in the recent past → carries an invoice + a settled payment.
    const completed = await bookings.create({
      customerId: customers[0]!.id,
      vehicleId: vehicles[0]!.id,
      pickupAt: now.minus({ days: 20 }),
      dropoffAt: now.minus({ days: 17 }),
      confirm: true,
    })
    await bookings.activate(completed.id)
    await bookings.complete(completed.id)
    const invoice = await invoicing.generateForBooking(completed.id)
    await Payment.create({
      id: randomUUID(),
      bookingId: completed.id,
      amount: invoice.total,
      currency: invoice.currency,
      method: 'card',
      status: 'paid',
      reference: `PAY-${invoice.number}`,
      paidAt: now.minus({ days: 20 }),
    })

    // An active rental spanning today → the picked-up vehicle shows as rented.
    const active = await bookings.create({
      customerId: customers[1]!.id,
      vehicleId: vehicles[1]!.id,
      pickupAt: now.minus({ days: 1 }),
      dropoffAt: now.plus({ days: 3 }),
      confirm: true,
    })
    await bookings.activate(active.id)

    // A confirmed upcoming rental with paid extras.
    await bookings.create({
      customerId: customers[2]!.id,
      vehicleId: vehicles[2]!.id,
      pickupAt: now.plus({ days: 5 }),
      dropoffAt: now.plus({ days: 9 }),
      extras: ['gps', 'child_seat'],
      confirm: true,
    })

    // An open quote a renter has not committed to yet.
    await bookings.create({
      customerId: customers[customers.length - 1]!.id,
      vehicleId: vehicles[3]!.id,
      pickupAt: now.plus({ days: 14 }),
      dropoffAt: now.plus({ days: 16 }),
      confirm: false,
    })
  }

  // ─── RAG corpus: policy docs + their embeddings ──────────────────
  /**
   * Create the fleet-assistant knowledge docs and embed their bodies into the
   * per-tenant `ai_embeddings` store so `retrieve:true` returns grounded matches.
   *
   * The AI satellite's ingestion service is internal (not a public export) and,
   * more to the point, it meters `aiTokens` quota — which would make a company
   * show AI usage before anyone has chatted. So this uses the two PUBLIC seams
   * the app already owns: the registered embedding provider (mock offline, the
   * real backend when a key is configured, so docs and queries always share one
   * vector space) to produce the vectors, and a direct insert into the app-owned
   * `ai_embeddings` table (the same table the app's own tenant migration 0014
   * declares), mirroring the vector store's idempotent `ON CONFLICT` insert.
   */
  async #seedKnowledge(company: Tenant): Promise<number> {
    const { default: FleetDoc } = await import('#app/models/tenant_scoped/fleet_doc')
    const { EmbeddingProviderRegistry } = await import('@adonisjs-lasagna/ai')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { default: multitenancyConfig } = await import('#config/multitenancy')

    const registry = await this.app.container.make(EmbeddingProviderRegistry)
    const provider = registry.resolve(multitenancyConfig.ai.embedding)
    const client = db.connection(`${multitenancyConfig.tenantConnectionNamePrefix}${company.id}`)

    let embedded = 0
    for (const doc of FLEET_DOCS) {
      let row = await FleetDoc.query().where('source', doc.source).first()
      if (!row) {
        row = await FleetDoc.create({
          id: randomUUID(),
          title: doc.title,
          body: doc.body,
          source: doc.source,
        })
      }

      const result = await provider.embed({ input: [doc.body] }, AbortSignal.timeout(30_000))
      const vector = result.embeddings[0] ?? []
      const contentHash = dedupHash(result.model, doc.body)
      // safe-sql: `ai_embeddings` is a fixed table this app owns; every value is a
      // bind. Mirrors VectorStoreService.insert so a later /ai/embed of the same
      // doc dedups against this row rather than duplicating it. `actor` is omitted
      // (it defaults to NULL): these rows are system-seeded, not user-attributed.
      await client.rawQuery(
        `INSERT INTO ai_embeddings (source, content_hash, content, metadata, model, dim, embedding) ` +
          `VALUES (?, ?, ?, ?::jsonb, ?, ?, ?::vector) ON CONFLICT (source, content_hash) DO NOTHING`,
        [
          doc.source,
          contentHash,
          doc.body,
          JSON.stringify({ title: doc.title, kind: 'fleet-doc' }),
          result.model,
          result.dimension,
          `[${vector.join(',')}]`,
        ]
      )
      if (!row.embeddedAt) {
        row.embeddedAt = DateTime.now()
        await row.save()
      }
      embedded++
    }
    return embedded
  }
}

/**
 * The row dedup key the vector store uses: SHA-256 over (SHA-256(model), content).
 * Replicated so a seeded row and one later ingested through `/ai/embed` collide
 * on the `UNIQUE (source, content_hash)` constraint instead of double-storing.
 */
function dedupHash(model: string, content: string): string {
  const modelKey = createHash('sha256').update(model).digest('hex')
  return createHash('sha256').update(modelKey).update(content).digest('hex')
}

// ─── Seed data ─────────────────────────────────────────────────────
// Money is integer santimat (1 MAD = 100 santimat) throughout.

type LocationType = 'airport' | 'city' | 'depot'
type FuelType = 'petrol' | 'diesel' | 'hybrid' | 'electric'
type Transmission = 'manual' | 'automatic'
type CategoryCode = 'economy' | 'compact' | 'suv' | 'luxury' | 'van'

interface LocationSpec {
  name: string
  type: LocationType
  city: string
  address: string
  phone?: string
  openHour?: number
  closeHour?: number
}

interface VehicleSpec {
  plate: string
  makeSlug: string
  modelName: string
  categoryCode: CategoryCode
  year: number
  fuel: FuelType
  transmission: Transmission
  color: string
  mileage: number
  locationIndex: number
}

interface CustomerSpec {
  fullName: string
  email: string
  phone: string
  cin?: string
  driverLicense?: string
  passport?: string
  address: string
  dateOfBirth: string
  nationality: string
}

interface SeedProfile {
  locations: LocationSpec[]
  vehicles: VehicleSpec[]
  customers: CustomerSpec[]
}

const CATEGORIES: Array<{
  name: string
  code: CategoryCode
  dailyRate: number
  depositAmount: number
  extras: string[]
}> = [
  { name: 'Economy', code: 'economy', dailyRate: 20_000, depositAmount: 300_000, extras: ['gps'] },
  {
    name: 'Compact',
    code: 'compact',
    dailyRate: 28_000,
    depositAmount: 400_000,
    extras: ['gps', 'additional_driver'],
  },
  {
    name: 'SUV',
    code: 'suv',
    dailyRate: 45_000,
    depositAmount: 700_000,
    extras: ['gps', 'child_seat'],
  },
  {
    name: 'Luxury',
    code: 'luxury',
    dailyRate: 90_000,
    depositAmount: 1_500_000,
    extras: ['gps', 'child_seat', 'chauffeur'],
  },
  {
    name: 'Van',
    code: 'van',
    dailyRate: 55_000,
    depositAmount: 800_000,
    extras: ['gps', 'additional_driver'],
  },
]

const FLEET_DOCS: Array<{ source: string; title: string; body: string }> = [
  {
    source: 'policy-rental-terms',
    title: 'Rental Terms & Conditions',
    body:
      'Renters must be at least 21 years old and have held a valid driving licence for one year or ' +
      'more. A security deposit is pre-authorised on the renter card at pickup and released after the ' +
      'car is returned undamaged. Economy and compact categories include unlimited mileage; SUV and ' +
      'luxury categories are capped at 250 km per day with an excess-kilometre charge. Cross-border ' +
      'travel outside Morocco requires prior written authorisation and a supplementary insurance rider.',
  },
  {
    source: 'policy-insurance',
    title: 'Insurance & Damage Waiver',
    body:
      'Every vehicle includes third-party liability cover as required by Moroccan law. The optional ' +
      'Collision Damage Waiver reduces the renter liability to the stated deductible. Tyres, the ' +
      'windscreen, the underbody and lost keys are excluded from the standard waiver unless the ' +
      'premium protection package is purchased at booking. Damage must be reported within 24 hours and ' +
      'a police report is required for any theft or third-party accident.',
  },
  {
    source: 'policy-fuel',
    title: 'Fuel Policy',
    body:
      'Vehicles are supplied full-to-full: the tank is full at pickup and must be returned full. A ' +
      'car returned with less fuel is charged for the missing litres plus a refuelling service fee. ' +
      'Diesel vehicles are labelled on the key fob and the fuel filler cap; using the wrong fuel is ' +
      'billed to the renter. Electric and hybrid vehicles are returned charged above 50 percent.',
  },
  {
    source: 'faq-pickup',
    title: 'Pickup & Return FAQ',
    body:
      'Airport pickups include a meet-and-greet at the arrivals hall; bring the booking reference, your ' +
      'passport or CIN and your driving licence. City-branch pickups open from 8am. Late returns beyond ' +
      'the 59-minute grace period are charged one additional rental day. A different drop-off branch is ' +
      'possible for a one-way fee quoted at booking. Child seats and additional drivers are added at the desk.',
  },
]

const PROFILES: Record<'starter' | 'full', SeedProfile> = {
  // Fleet / enterprise plans: three branches, a dozen cars, four renters.
  full: {
    locations: [
      {
        name: 'Casablanca Mohammed V Airport',
        type: 'airport',
        city: 'Casablanca',
        address: 'Nouaceur, Casablanca 20240',
        openHour: 6,
        closeHour: 23,
      },
      {
        name: 'Casablanca Downtown',
        type: 'city',
        city: 'Casablanca',
        address: 'Bd Mohammed V, Casablanca 20250',
      },
      {
        name: 'Marrakech Menara Airport',
        type: 'airport',
        city: 'Marrakech',
        address: 'Menara, Marrakech 40000',
        openHour: 6,
        closeHour: 23,
      },
    ],
    vehicles: [
      {
        plate: '10001-A-6',
        makeSlug: 'dacia',
        modelName: 'Sandero',
        categoryCode: 'economy',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'White',
        mileage: 24_500,
        locationIndex: 0,
      },
      {
        plate: '10002-A-6',
        makeSlug: 'hyundai',
        modelName: 'i10',
        categoryCode: 'economy',
        year: 2022,
        fuel: 'petrol',
        transmission: 'manual',
        color: 'Grey',
        mileage: 41_200,
        locationIndex: 1,
      },
      {
        plate: '10003-A-6',
        makeSlug: 'toyota',
        modelName: 'Yaris',
        categoryCode: 'economy',
        year: 2023,
        fuel: 'hybrid',
        transmission: 'automatic',
        color: 'Red',
        mileage: 18_900,
        locationIndex: 0,
      },
      {
        plate: '10004-A-6',
        makeSlug: 'renault',
        modelName: 'Clio',
        categoryCode: 'compact',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Blue',
        mileage: 30_100,
        locationIndex: 1,
      },
      {
        plate: '10005-A-6',
        makeSlug: 'peugeot',
        modelName: '208',
        categoryCode: 'compact',
        year: 2022,
        fuel: 'petrol',
        transmission: 'manual',
        color: 'Black',
        mileage: 52_300,
        locationIndex: 0,
      },
      {
        plate: '10006-A-6',
        makeSlug: 'dacia',
        modelName: 'Logan',
        categoryCode: 'compact',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Silver',
        mileage: 27_800,
        locationIndex: 2,
      },
      {
        plate: '10007-A-6',
        makeSlug: 'toyota',
        modelName: 'Corolla',
        categoryCode: 'compact',
        year: 2024,
        fuel: 'hybrid',
        transmission: 'automatic',
        color: 'White',
        mileage: 9_400,
        locationIndex: 1,
      },
      {
        plate: '10008-A-6',
        makeSlug: 'dacia',
        modelName: 'Duster',
        categoryCode: 'suv',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Beige',
        mileage: 33_600,
        locationIndex: 0,
      },
      {
        plate: '10009-A-6',
        makeSlug: 'peugeot',
        modelName: '3008',
        categoryCode: 'suv',
        year: 2024,
        fuel: 'diesel',
        transmission: 'automatic',
        color: 'Grey',
        mileage: 12_050,
        locationIndex: 2,
      },
      {
        plate: '10010-A-6',
        makeSlug: 'toyota',
        modelName: 'RAV4',
        categoryCode: 'suv',
        year: 2024,
        fuel: 'hybrid',
        transmission: 'automatic',
        color: 'Blue',
        mileage: 7_800,
        locationIndex: 0,
      },
      {
        plate: '10011-A-6',
        makeSlug: 'hyundai',
        modelName: 'Tucson',
        categoryCode: 'suv',
        year: 2023,
        fuel: 'diesel',
        transmission: 'automatic',
        color: 'Black',
        mileage: 21_400,
        locationIndex: 1,
      },
      {
        plate: '10012-A-6',
        makeSlug: 'renault',
        modelName: 'Kangoo',
        categoryCode: 'van',
        year: 2022,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'White',
        mileage: 61_700,
        locationIndex: 2,
      },
    ],
    customers: [
      {
        fullName: 'Youssef El Amrani',
        email: 'youssef.elamrani@example.ma',
        phone: '+212611000001',
        cin: 'BE102938',
        driverLicense: 'DL445566',
        address: '12 Rue des Fleurs, Casablanca',
        dateOfBirth: '1988-03-12',
        nationality: 'MA',
      },
      {
        fullName: 'Fatima Zahra Bennani',
        email: 'fatimazahra.bennani@example.ma',
        phone: '+212611000002',
        cin: 'BK884412',
        driverLicense: 'DL992133',
        address: '44 Av Hassan II, Rabat',
        dateOfBirth: '1992-07-25',
        nationality: 'MA',
      },
      {
        fullName: 'Karim Idrissi',
        email: 'karim.idrissi@example.ma',
        phone: '+212611000003',
        cin: 'AB556677',
        driverLicense: 'DL330099',
        passport: 'MA1234567',
        address: '8 Rue Atlas, Marrakech',
        dateOfBirth: '1985-11-02',
        nationality: 'MA',
      },
      {
        fullName: 'Sophie Laurent',
        email: 'sophie.laurent@example.fr',
        phone: '+33600000004',
        driverLicense: 'FR778812',
        passport: 'FR9988776',
        address: 'Rue de Rivoli, Paris',
        dateOfBirth: '1990-01-19',
        nationality: 'FR',
      },
    ],
  },
  // Starter plan: two branches, a handful of cars, three renters (stays under the
  // starter vehiclesPerTenant=10 quota).
  starter: {
    locations: [
      {
        name: 'Agadir Al Massira Airport',
        type: 'airport',
        city: 'Agadir',
        address: 'Al Massira, Agadir 80000',
        openHour: 6,
        closeHour: 22,
      },
      {
        name: 'Agadir City Center',
        type: 'city',
        city: 'Agadir',
        address: 'Av Hassan II, Agadir 80000',
      },
    ],
    vehicles: [
      {
        plate: '20001-S-6',
        makeSlug: 'dacia',
        modelName: 'Sandero',
        categoryCode: 'economy',
        year: 2022,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'White',
        mileage: 48_200,
        locationIndex: 0,
      },
      {
        plate: '20002-S-6',
        makeSlug: 'hyundai',
        modelName: 'i10',
        categoryCode: 'economy',
        year: 2023,
        fuel: 'petrol',
        transmission: 'manual',
        color: 'Blue',
        mileage: 22_600,
        locationIndex: 1,
      },
      {
        plate: '20003-S-6',
        makeSlug: 'renault',
        modelName: 'Clio',
        categoryCode: 'compact',
        year: 2022,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Grey',
        mileage: 39_900,
        locationIndex: 0,
      },
      {
        plate: '20004-S-6',
        makeSlug: 'peugeot',
        modelName: '301',
        categoryCode: 'compact',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Silver',
        mileage: 28_300,
        locationIndex: 1,
      },
      {
        plate: '20005-S-6',
        makeSlug: 'dacia',
        modelName: 'Duster',
        categoryCode: 'suv',
        year: 2023,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'Beige',
        mileage: 19_100,
        locationIndex: 0,
      },
      {
        plate: '20006-S-6',
        makeSlug: 'renault',
        modelName: 'Kangoo',
        categoryCode: 'van',
        year: 2021,
        fuel: 'diesel',
        transmission: 'manual',
        color: 'White',
        mileage: 72_400,
        locationIndex: 1,
      },
    ],
    customers: [
      {
        fullName: 'Hassan Ouahbi',
        email: 'hassan.ouahbi@example.ma',
        phone: '+212612000001',
        cin: 'JD223344',
        driverLicense: 'DL112255',
        address: '3 Av Hassan II, Agadir',
        dateOfBirth: '1979-06-30',
        nationality: 'MA',
      },
      {
        fullName: 'Nadia Chraibi',
        email: 'nadia.chraibi@example.ma',
        phone: '+212612000002',
        cin: 'JC778899',
        driverLicense: 'DL665544',
        address: '21 Rue Souss, Agadir',
        dateOfBirth: '1995-09-14',
        nationality: 'MA',
      },
      {
        fullName: 'Omar Tazi',
        email: 'omar.tazi@example.ma',
        phone: '+212612000003',
        cin: 'JE445566',
        driverLicense: 'DL887766',
        address: 'Taroudant Centre',
        dateOfBirth: '1983-12-05',
        nationality: 'MA',
      },
    ],
  },
}
