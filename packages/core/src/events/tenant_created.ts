import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Domain event dispatched after a new tenant has been provisioned, extending the AdonisJS
 * BaseEvent so listeners can subscribe through the framework emitter. It carries the newly
 * created tenant as a single readonly `tenant` property typed against TenantModelContract,
 * letting host applications react to tenant creation, for example by seeding data or sending
 * onboarding notifications.
 *
 * @property tenant - The newly created tenant record, conforming to TenantModelContract.
 */
export default class TenantCreated extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
