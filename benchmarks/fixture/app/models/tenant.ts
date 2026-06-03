import { BackofficeBaseModel } from '@adonisjs-lasagna/saas-tenancy/base-models'
import { column, scope } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import multitenancyConfig from '../../config/multitenancy.js'
import type { TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Lean tenant registry model. The bench provisions tenant storage directly
 * (see src/harness/provision.ts), so this model carries only what the
 * repository, the tenant guard, and `request.tenant()` read — no install /
 * migrate / connection plumbing.
 */
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

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null

  static active = scope((query) => {
    query.where('status', 'active').whereNull('deleted_at')
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

  get schemaName() {
    return `${multitenancyConfig.tenantSchemaPrefix}${this.id}`
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
