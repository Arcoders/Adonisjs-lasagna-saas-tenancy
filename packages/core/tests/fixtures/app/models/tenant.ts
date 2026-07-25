import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, scope } from '@adonisjs/lucid/orm'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import type { PostgreConfig } from '@adonisjs/lucid/types/database'
import type { MigratorOptions } from '@adonisjs/lucid/types/migrator'
import { DateTime } from 'luxon'
import assert from 'node:assert'
import multitenancyConfig from '../../config/multitenancy.js'
import type { TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

const MAX_TENANT_CONNECTIONS = 50
const connectionLru = new Map<string, number>()

export default class Tenant extends BackofficeBaseModel {
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

  @column()
  declare maintenance: boolean

  @column()
  declare maintenanceMessage: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null

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
    assert(config, 'Unable to get connection config')

    db.manager.add(this.connectionName, {
      ...config,
      searchPath: [this.schemaName],
    } as PostgreConfig)

    connectionLru.set(this.connectionName, Date.now())

    if (connectionLru.size > MAX_TENANT_CONNECTIONS) {
      const oldest = connectionLru.keys().next().value!
      connectionLru.delete(oldest)
      db.manager.close(oldest).catch(() => {})
    }

    return db.connection(this.connectionName)
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

  async invalidateCache() {}
}
