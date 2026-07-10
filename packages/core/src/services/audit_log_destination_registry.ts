import { assertContractCompat } from '../sdk/contract_version.js'
import type { AuditActorType } from '../models/satellites/tenant_audit_log.js'

/**
 * The audit destination contract version: the shape of {@link AuditLogDestination}.
 * Bump as a MAJOR for a backward-incompatible change. INDEPENDENT of
 * `satelliteApi` and the published version.
 */
export const AUDIT_CONTRACT_VERSION = 1

/**
 * Shape of a single persisted audit row that is handed to every registered audit
 * destination after it has been written to the canonical `tenant_audit_log` table.
 * It carries the row id, the owning tenant id, the actor type and id, the action
 * string, optional structured metadata, the originating IP address, and an ISO 8601
 * creation timestamp describing the database row.
 */
export interface AuditLogEntry {
  id: string
  tenantId: string | null
  actorType: AuditActorType
  actorId: string | null
  action: string
  metadata: Record<string, unknown> | null
  ipAddress: string | null
  /** ISO 8601 creation timestamp of the canonical DB row. */
  createdAt: string
}

/**
 * A host-registered sink that receives every audit entry AFTER it is written to
 * the canonical `tenant_audit_log` table (Datadog, Splunk, an S3 archive, …).
 * Destinations are best-effort: a slow or throwing destination never affects the
 * DB write or the audited operation (see `AuditLogService.log`).
 */
export interface AuditLogDestination {
  readonly name: string
  /** Contract version this destination was built against (see {@link AUDIT_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  write(entry: AuditLogEntry): Promise<void> | void
}

/**
 * Registry of host audit destinations. Bound as a container singleton by
 * `MultitenancyProvider`; the host registers destinations in its provider
 * `boot()`. Map-backed (stateful): resolve via `container.make`, never `new`.
 *
 * Empty by default. The DB table writer is the only destination and behavior is
 * unchanged.
 */
export default class AuditLogDestinationRegistry {
  readonly #destinations = new Map<string, AuditLogDestination>()

  /** The destination-contract version this surface implements. */
  get contractVersion(): number {
    return AUDIT_CONTRACT_VERSION
  }

  register(destination: AuditLogDestination): this {
    if (!destination.name || typeof destination.name !== 'string') {
      throw new Error('AuditLogDestinationRegistry: a destination must have a non-empty name.')
    }
    if (this.#destinations.has(destination.name)) {
      throw new Error(
        `AuditLogDestinationRegistry: a destination named "${destination.name}" is already registered.`
      )
    }
    assertContractCompat(
      destination.contractVersion,
      AUDIT_CONTRACT_VERSION,
      `audit destination "${destination.name}"`
    )
    this.#destinations.set(destination.name, destination)
    return this
  }

  /** Registered destinations, in registration order. */
  list(): readonly AuditLogDestination[] {
    return [...this.#destinations.values()]
  }

  has(name: string): boolean {
    return this.#destinations.has(name)
  }

  clear(): this {
    this.#destinations.clear()
    return this
  }
}
