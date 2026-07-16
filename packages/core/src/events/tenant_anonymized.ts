import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Dispatched after a REAL `tenant:gdpr:anonymize` run executes the host
 * anonymizer for a tenant (GDPR Art.17 erasure-by-anonymization). Never fired
 * for `--dry-run`, so a listener can safely treat it as "PII was erased" and fan
 * out to downstream systems (data warehouse, search index) that hold copies.
 * `affected` is the count the host anonymizer reported, when it returned one.
 */
export default class TenantAnonymized extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly details: { reason?: string; affected?: number }
  ) {
    super()
  }
}
