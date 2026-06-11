import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { ReadReplicaService } from '@adonisjs-lasagna/saas-tenancy/services'
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
 * The shape of `tenant.metadata` in this demo. Drives both:
 *  - plan resolution (`config.plans.getPlan`)
 *  - retention tier resolution (`config.backup.retention.getTier`)
 *
 * This is the value of the generic in TenantModelContract<DemoMeta> — see
 * controllers/demo/notes_controller.ts for `request.tenant<DemoMeta>()` usage.
 */
export interface DemoMeta {
  plan: 'free' | 'pro'
  tier: 'standard' | 'premium'
  industry?: string
  // The contract's TenantMetadata is Record<string, unknown>; this index
  // signature keeps DemoMeta assignable to it, so values typed
  // TenantModelContract<DemoMeta> flow into package APIs that take the
  // default TenantModelContract without casts.
  [key: string]: unknown
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
    prepare: (value: DemoMeta | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | DemoMeta | null) =>
      typeof value === 'string' ? (JSON.parse(value) as DemoMeta) : value,
  })
  declare metadata: DemoMeta

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

  // Optional contract method — when a replica is configured, route reads to it.
  // Falls back to the primary connection when no replica is registered.
  //
  // We re-implement the resolve step instead of calling replicaService.resolve()
  // because the package puts searchPath inside the `connection` block as a string,
  // whereas Lucid expects it at the top level as an array. This shape difference
  // is a known caveat — track upstream.
  async getReadConnection() {
    const host = replicaService.pickHost(this.id)
    if (!host) return this.getConnection()

    const idx = replicaService.pickIndex(this.id)!
    const connName = replicaService.connectionName(this.id, idx)

    if (!db.manager.has(connName)) {
      this.getConnection() // ensure primary exists so we can clone its config
      const primary = db.manager.get(this.connectionName)?.config as PostgreConfig | undefined
      assert(primary, 'Primary tenant connection missing')
      const baseConn: any = primary.connection ?? {}
      db.manager.add(connName, {
        ...primary,
        connection: {
          ...baseConn,
          host: host.host,
          port: host.port ?? baseConn.port,
          user: host.user ?? baseConn.user,
          password: host.password ?? baseConn.password,
        },
        searchPath: [this.schemaName],
      } as PostgreConfig)
    }

    return db.connection(connName)
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
    this.deletedAt = DateTime.now()
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

  async invalidateCache() {}
}
