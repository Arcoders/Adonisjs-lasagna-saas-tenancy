import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * AdonisJS event dispatched after a new tenant has been provisioned, extending the
 * framework's BaseEvent so listeners can subscribe through the standard emitter. It
 * carries a single readonly `tenant` payload conforming to TenantModelContract, giving
 * subscribers access to the newly created tenant's id, name, email, status, and metadata.
 *
 * @example
 * emitter.on(TenantProvisioned, (event) => console.log(event.tenant.id))
 */
export default class TenantProvisioned extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
