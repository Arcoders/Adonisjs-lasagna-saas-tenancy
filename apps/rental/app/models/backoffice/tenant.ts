import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import {
  ReadReplicaService,
  PGVECTOR_EXTENSION_SCHEMA,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { column, scope } from '@adonisjs/lucid/orm'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import type { PostgreConfig } from '@adonisjs/lucid/types/database'
import type { MigratorOptions } from '@adonisjs/lucid/types/migrator'
import { DateTime } from 'luxon'
import assert from 'node:assert'
import multitenancyConfig from '#config/multitenancy'
import type { TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The shape of `tenant.metadata` — one rental company's SaaS subscription
 * facts. Drives plan resolution (`config.plans.getPlan`), backup retention tier
 * (`config.backup.retention.getTier`), and the localised money/tax defaults the
 * domain uses (Morocco: MAD, 20% VAT).
 *
 * A type alias (not an interface) on purpose: aliases get an implicit index
 * signature, so `RentalMeta` stays assignable to the contract's
 * `TenantMetadata` without a cast, while object literals still get
 * excess-property checking (a typo like `plann:` stays a compile error).
 */
export type RentalMeta = {
  plan: 'starter' | 'fleet' | 'enterprise'
  tier: 'standard' | 'premium'
  country: string
  currency: string
  industry?: string
}

const MAX_TENANT_CONNECTIONS = 50
const connectionLru = new Map<string, number>()
const replicaService = new ReadReplicaService()

export default class Tenant extends BackofficeBaseModel {
  static table = 'tenants'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare email: string

  @column()
  declare status: TenantStatus

  @column()
  declare customDomain: string | null

  @column({
    prepare: (value: RentalMeta | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | RentalMeta | null) =>
      typeof value === 'string' ? (JSON.parse(value) as RentalMeta) : value,
  })
  declare metadata: RentalMeta

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null

  @column()
  declare maintenance: boolean

  @column()
  declare maintenanceMessage: string | null

  static active = scope((query) => {
    query.where('status', 'active').whereNull('deleted_at')
  })

  static notDeleted = scope((query) => {
    query.whereNull('deleted_at')
  })

  get isActive() {
    return this.status === 'active' && this.deletedAt === null
  }
  get isSuspended() {
    return this.status === 'suspended'
  }
  get isProvisioning() {
    return this.status === 'provisioning'
  }
  get isFailed() {
    return this.status === 'failed'
  }
  get isDeleted() {
    return this.deletedAt !== null
  }
  get isMaintenance() {
    return this.maintenance === true
  }

  async enterMaintenance(message?: string | null) {
    this.maintenance = true
    this.maintenanceMessage = message ?? null
    await this.save()
  }

  async exitMaintenance() {
    this.maintenance = false
    this.maintenanceMessage = null
    await this.save()
  }

  private get connectionName() {
    return `${multitenancyConfig.tenantConnectionNamePrefix}${this.id}`
  }

  get schemaName() {
    return `${multitenancyConfig.tenantSchemaPrefix}${this.id}`
  }

  async closeConnection() {
    connectionLru.delete(this.connectionName)
    if (db.manager.has(this.connectionName)) {
      await db.manager.close(this.connectionName)
    }
  }

  async migrate(options: Omit<MigratorOptions, 'connectionName'>) {
    const migrator = new MigrationRunner(db, app, {
      ...options,
      connectionName: this.connectionName,
    })
    await migrator.run()
    if (migrator.error) throw migrator.error
    return migrator
  }

  getConnection() {
    if (db.manager.has(this.connectionName)) {
      connectionLru.delete(this.connectionName)
      connectionLru.set(this.connectionName, Date.now())
      return db.connection(this.connectionName)
    }

    const config = db.manager.get('tenant')?.config
    assert(config, 'Unable to get tenant template connection config')

    db.manager.add(this.connectionName, {
      ...config,
      // The tenant schema stays FIRST (all tenant objects resolve there); the
      // shared pgvector `extensions` schema is appended so the
      // `ai_embeddings vector(N)` column + operators resolve. `public` (central
      // catalog) is deliberately kept off the tenant path.
      searchPath: [this.schemaName, PGVECTOR_EXTENSION_SCHEMA],
    } as PostgreConfig)

    connectionLru.set(this.connectionName, Date.now())
    if (connectionLru.size > MAX_TENANT_CONNECTIONS) {
      const oldest = connectionLru.keys().next().value!
      connectionLru.delete(oldest)
      db.manager.close(oldest).catch(() => {})
    }

    return db.connection(this.connectionName)
  }

  // When a replica is configured, route reads to it via the package's
  // ReadReplicaService. Falls back to the primary when none is registered.
  async getReadConnection() {
    return (await replicaService.resolve(this)) ?? this.getConnection()
  }

  async install() {
    try {
      this.status = 'provisioning'
      await this.save()
      await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${this.schemaName}"`)
      this.getConnection()
      this.status = 'active'
      await this.save()
    } catch (error) {
      this.status = 'failed'
      await this.save()
      throw error
    }
  }

  async uninstall() {
    await this.closeConnection()
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${this.schemaName}" CASCADE`)
    // Invariant A: deletedAt and status move together.
    this.deletedAt = DateTime.now()
    this.status = 'deleted'
    await this.save()
  }

  async dropSchemaIfExists() {
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${this.schemaName}" CASCADE`)
  }

  async suspend() {
    this.status = 'suspended'
    await this.save()
  }

  async activate() {
    this.status = 'active'
    await this.save()
  }
}
