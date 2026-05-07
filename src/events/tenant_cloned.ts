import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'
import type { CloneResult } from '../services/clone_service.js'

export default class TenantCloned extends BaseEvent {
  constructor(
    readonly source: TenantModelContract,
    readonly destination: TenantModelContract,
    readonly result: CloneResult
  ) {
    super()
  }
}
